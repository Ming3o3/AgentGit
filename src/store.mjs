import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sanitizePayload } from './payload.mjs';
import Database from 'better-sqlite3';
import { canonicalJson, sha256 } from './canonical-json.mjs';

const SCHEMA_VERSION = 1;

function now() {
  return new Date().toISOString();
}

function id() {
  return `evt_${crypto.randomUUID()}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  return JSON.parse(value);
}

export function repoDbPath(repo) {
  return path.join(path.resolve(repo), '.agentgit', 'events.db');
}

export function initRepository(repo) {
  const root = path.resolve(repo);
  const directory = path.join(root, '.agentgit');
  fs.mkdirSync(directory, { recursive: true });
  const database = new Database(path.join(directory, 'events.db'));
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      session_id TEXT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      parents_json TEXT NOT NULL,
      causation_id TEXT,
      payload_json TEXT NOT NULL,
      source_json TEXT,
      created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS refs (
      name TEXT PRIMARY KEY,
      event_id TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE TABLE IF NOT EXISTS ingest_cursors (
      source_key TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_events (
      source_key TEXT NOT NULL,
      source_offset INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      PRIMARY KEY (source_key, source_offset),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      event_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'acknowledged')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      acknowledged_at TEXT,
      PRIMARY KEY (event_id, recipient_id),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE INDEX IF NOT EXISTS events_task_time ON events(task_id, created_at);
    CREATE INDEX IF NOT EXISTS events_agent_time ON events(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS events_type_time ON events(type, created_at);
    CREATE INDEX IF NOT EXISTS deliveries_recipient_status ON deliveries(recipient_id, status, created_at);
    CREATE TRIGGER IF NOT EXISTS events_are_immutable_on_update
      BEFORE UPDATE ON events BEGIN
        SELECT RAISE(ABORT, 'events are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS events_are_immutable_on_delete
      BEFORE DELETE ON events BEGIN
        SELECT RAISE(ABORT, 'events are immutable');
      END;
    INSERT INTO metadata(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  `);
  database.close();
  ensureGitExcludesState(root);
  return { repo: root, database: path.join(directory, 'events.db') };
}

function ensureGitExcludesState(root) {
  let excludePath;
  try {
    excludePath = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return;
  }
  if (!path.isAbsolute(excludePath)) excludePath = path.resolve(root, excludePath);
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const current = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes('.agentgit/')) {
    fs.appendFileSync(excludePath, `${current && !current.endsWith('\n') ? '\n' : ''}.agentgit/\n`);
  }
}

export class EventStore {
  constructor(repo) {
    this.repo = path.resolve(repo);
    this.database = new Database(repoDbPath(this.repo));
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
  }

  close() {
    this.database.close();
  }

  append(input) {
    const transaction = this.database.transaction(() => this.#insertEvent(input));
    return transaction();
  }

  importJsonl({ filePath, agentId, taskId = null, sessionId = null, ref = null, sourceKey = `jsonl:${path.resolve(filePath)}`, adapter }) {
    const absolutePath = path.resolve(filePath);
    const currentSize = fs.statSync(absolutePath).size;
    const cursor = this.database.prepare('SELECT byte_offset FROM ingest_cursors WHERE source_key = ?').get(sourceKey);
    const startOffset = cursor && cursor.byte_offset <= currentSize ? cursor.byte_offset : 0;
    const bytes = fs.readFileSync(absolutePath);
    const completeBytes = bytes.subarray(startOffset, bytes.lastIndexOf(0x0a, bytes.length - 1) + 1);
    if (completeBytes.length === 0) return { imported: 0, skipped: 0, offset: startOffset };
    const transaction = this.database.transaction(() => {
      let imported = 0;
      let skipped = 0;
      let offset = startOffset;
      for (const lineBytes of completeBytes.toString('utf8').split('\n').slice(0, -1)) {
        const lineStart = offset;
        offset += Buffer.byteLength(`${lineBytes}\n`);
        let raw;
        try { raw = JSON.parse(lineBytes); } catch { skipped += 1; this.#advanceCursor(sourceKey, absolutePath, offset); continue; }
        const normalized = adapter(raw);
        if (!normalized) { skipped += 1; this.#advanceCursor(sourceKey, absolutePath, offset); continue; }
        this.#insertEvent({
          agentId,
          type: normalized.type,
          payload: normalized.payload,
          taskId,
          sessionId,
          ref,
          source: {
            adapter: normalized.adapter ?? 'jsonl',
            path: absolutePath,
            byteOffset: lineStart,
            rawType: raw.type ?? null,
            payloadType: raw.payload?.type ?? null,
          },
          ingest: { sourceKey, sourceOffset: lineStart, filePath: absolutePath, nextOffset: offset },
        });
        imported += 1;
      }
      return { imported, skipped, offset };
    });
    return transaction();
  }

  sendMessage({ from, to, text, subject = null, taskId = null, sessionId = null, ref = null, references = [] }) {
    const recipients = Array.isArray(to) ? to : [to];
    const cleanedRecipients = [...new Set(recipients.map((item) => String(item).trim()).filter(Boolean))];
    if (cleanedRecipients.length === 0) throw new Error('at least one recipient is required');
    if (typeof text !== 'string' || !text.trim()) throw new Error('message text is required');
    if (!Array.isArray(references)) throw new Error('references must be an array');
    const transaction = this.database.transaction(() => {
      const event = this.#insertEvent({
        agentId: from,
        type: 'message.sent',
        taskId,
        sessionId,
        ref,
        payload: { to: cleanedRecipients, subject, text, references },
      });
      const insert = this.database.prepare(`
        INSERT INTO deliveries(event_id, recipient_id, status, created_at)
        VALUES (?, ?, 'pending', ?)
      `);
      for (const recipient of cleanedRecipients) insert.run(event.id, recipient, event.createdAt);
      return event;
    });
    return transaction();
  }

  inbox({ agentId, status = null, limit = 100 } = {}) {
    if (!agentId?.trim()) throw new Error('agentId is required');
    const values = [agentId];
    const condition = status ? 'AND d.status = ?' : '';
    if (status) values.push(status);
    values.push(limit);
    return this.database.prepare(`
      SELECT e.*, d.recipient_id, d.status AS delivery_status, d.created_at AS delivery_created_at,
        d.delivered_at, d.acknowledged_at
      FROM deliveries d JOIN events e ON e.id = d.event_id
      WHERE d.recipient_id = ? ${condition}
      ORDER BY e.created_at ASC LIMIT ?
    `).all(...values).map((row) => ({
      ...this.#hydrate(row),
      delivery: {
        recipientId: row.recipient_id,
        status: row.delivery_status,
        createdAt: row.delivery_created_at,
        deliveredAt: row.delivered_at,
        acknowledgedAt: row.acknowledged_at,
      },
    }));
  }

  markDelivered(eventId, recipientId) {
    const result = this.database.prepare(`
      UPDATE deliveries SET status = CASE WHEN status = 'pending' THEN 'delivered' ELSE status END,
        delivered_at = CASE WHEN delivered_at IS NULL THEN ? ELSE delivered_at END
      WHERE event_id = ? AND recipient_id = ?
    `).run(now(), eventId, recipientId);
    if (result.changes === 0) throw new Error(`delivery does not exist: ${eventId} -> ${recipientId}`);
    return this.delivery(eventId, recipientId);
  }

  acknowledge(eventId, recipientId) {
    const result = this.database.prepare(`
      UPDATE deliveries SET status = 'acknowledged', delivered_at = COALESCE(delivered_at, ?),
        acknowledged_at = COALESCE(acknowledged_at, ?)
      WHERE event_id = ? AND recipient_id = ?
    `).run(now(), now(), eventId, recipientId);
    if (result.changes === 0) throw new Error(`delivery does not exist: ${eventId} -> ${recipientId}`);
    return this.delivery(eventId, recipientId);
  }

  delivery(eventId, recipientId) {
    const row = this.database.prepare('SELECT * FROM deliveries WHERE event_id = ? AND recipient_id = ?')
      .get(eventId, recipientId);
    return row ? {
      eventId: row.event_id,
      recipientId: row.recipient_id,
      status: row.status,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      acknowledgedAt: row.acknowledged_at,
    } : null;
  }

  #insertEvent(input) {
    const {
      agentId,
      type,
      payload = {},
      taskId = null,
      sessionId = null,
      causationId = null,
      source = null,
      ref = null,
      parents,
      createdAt = now(),
    } = input;
    if (!agentId?.trim()) throw new Error('agentId is required');
    if (!type?.trim()) throw new Error('type is required');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('payload must be a JSON object');
    }

    const { ingest = null } = input;
    if (ingest) {
      const existing = this.database.prepare('SELECT event_id FROM source_events WHERE source_key = ? AND source_offset = ?')
        .get(ingest.sourceKey, ingest.sourceOffset);
      if (existing) {
        this.#advanceCursor(ingest.sourceKey, ingest.filePath, ingest.nextOffset);
        return this.get(existing.event_id);
      }
    }
    {
      const refRow = ref
        ? this.database.prepare('SELECT event_id FROM refs WHERE name = ?').get(ref)
        : null;
      const resolvedParents = parents ?? (refRow?.event_id ? [refRow.event_id] : []);
      for (const parent of resolvedParents) {
        if (!this.database.prepare('SELECT 1 FROM events WHERE id = ?').get(parent)) {
          throw new Error(`parent event does not exist: ${parent}`);
        }
      }
      if (causationId && !this.database.prepare('SELECT 1 FROM events WHERE id = ?').get(causationId)) {
        throw new Error(`causation event does not exist: ${causationId}`);
      }
      const event = {
        id: id(),
        task_id: taskId,
        session_id: sessionId,
        agent_id: agentId,
        type,
        parents: [...new Set(resolvedParents)],
        causation_id: causationId,
        payload: sanitizePayload(payload, this.repo),
        source,
        created_at: createdAt,
      };
      const contentHash = sha256(event);
      this.database.prepare(`
        INSERT INTO events
          (id, task_id, session_id, agent_id, type, parents_json, causation_id,
           payload_json, source_json, created_at, content_hash)
        VALUES (@id, @task_id, @session_id, @agent_id, @type, @parents_json,
                @causation_id, @payload_json, @source_json, @created_at, @content_hash)
      `).run({
        id: event.id,
        task_id: event.task_id,
        session_id: event.session_id,
        agent_id: event.agent_id,
        type: event.type,
        parents_json: canonicalJson(event.parents),
        causation_id: event.causation_id,
        payload_json: canonicalJson(event.payload),
        source_json: event.source === null ? null : canonicalJson(event.source),
        created_at: event.created_at,
        content_hash: contentHash,
      });
      if (ref) {
        this.database.prepare(`
          INSERT INTO refs(name, event_id, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET event_id=excluded.event_id, updated_at=excluded.updated_at
        `).run(ref, event.id, now());
      }
      if (ingest) {
        this.database.prepare('INSERT INTO source_events(source_key, source_offset, event_id) VALUES (?, ?, ?)')
          .run(ingest.sourceKey, ingest.sourceOffset, event.id);
        this.#advanceCursor(ingest.sourceKey, ingest.filePath, ingest.nextOffset);
      }
      return {
        id: event.id,
        taskId: event.task_id,
        sessionId: event.session_id,
        agentId: event.agent_id,
        type: event.type,
        parents: event.parents,
        causationId: event.causation_id,
        payload: event.payload,
        source: event.source,
        createdAt: event.created_at,
        contentHash,
      };
    }
  }

  #advanceCursor(sourceKey, filePath, byteOffset) {
    this.database.prepare(`
      INSERT INTO ingest_cursors(source_key, file_path, byte_offset, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET file_path=excluded.file_path,
        byte_offset=excluded.byte_offset, updated_at=excluded.updated_at
    `).run(sourceKey, filePath, byteOffset, now());
  }

  get(eventId) {
    const row = this.database.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    return row ? this.#hydrate(row) : null;
  }

  list({ ref = null, taskId = null, agentId = null, type = null, limit = 100 } = {}) {
    const conditions = [];
    const values = [];
    if (ref) {
      const row = this.database.prepare('SELECT event_id FROM refs WHERE name = ?').get(ref);
      if (!row?.event_id) return [];
      const rows = this.database.prepare(`
        WITH RECURSIVE history(id) AS (
          SELECT ?
          UNION
          SELECT json_each.value FROM events, history, json_each(events.parents_json)
            WHERE events.id = history.id
        )
        SELECT events.* FROM events JOIN history ON history.id = events.id
        ORDER BY events.created_at ASC LIMIT ?
      `).all(row.event_id, limit);
      return rows.map((item) => this.#hydrate(item));
    }
    if (taskId) { conditions.push('task_id = ?'); values.push(taskId); }
    if (agentId) { conditions.push('agent_id = ?'); values.push(agentId); }
    if (type) { conditions.push('type = ?'); values.push(type); }
    values.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.database.prepare(`SELECT * FROM events ${where} ORDER BY created_at ASC LIMIT ?`)
      .all(...values).map((item) => this.#hydrate(item));
  }

  refs() {
    return this.database.prepare('SELECT name, event_id, updated_at FROM refs ORDER BY name').all();
  }

  verify(eventId) {
    const row = this.database.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!row) return { valid: false, reason: 'event not found' };
    const event = {
      id: row.id,
      task_id: row.task_id ?? null,
      session_id: row.session_id ?? null,
      agent_id: row.agent_id,
      type: row.type,
      parents: parseJson(row.parents_json, []),
      causation_id: row.causation_id ?? null,
      payload: parseJson(row.payload_json, {}),
      source: parseJson(row.source_json, null),
      created_at: row.created_at,
    };
    const actual = sha256(event);
    return { valid: actual === row.content_hash, expected: row.content_hash, actual };
  }

  #hydrate(row) {
    return {
      id: row.id,
      taskId: row.task_id ?? null,
      sessionId: row.session_id ?? null,
      agentId: row.agent_id,
      type: row.type,
      parents: parseJson(row.parents_json, []),
      causationId: row.causation_id ?? null,
      payload: parseJson(row.payload_json, {}),
      source: parseJson(row.source_json, null),
      createdAt: row.created_at,
      contentHash: row.content_hash,
    };
  }
}
