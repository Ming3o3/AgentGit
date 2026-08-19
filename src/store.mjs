import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
    CREATE INDEX IF NOT EXISTS events_task_time ON events(task_id, created_at);
    CREATE INDEX IF NOT EXISTS events_agent_time ON events(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS events_type_time ON events(type, created_at);
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
  return { repo: root, database: path.join(directory, 'events.db') };
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

    const transaction = this.database.transaction(() => {
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
        payload,
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
    });
    return transaction();
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
