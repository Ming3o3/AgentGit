import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sanitizePayload } from './payload.mjs';
import { readObject } from './objects.mjs';
import Database from 'better-sqlite3';
import { canonicalJson, sha256 } from './canonical-json.mjs';

const SCHEMA_VERSION = 2;
const TASK_STATUSES = new Set(['open', 'assigned', 'in_progress', 'blocked', 'completed', 'cancelled']);
const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const DELIVERY_STATUSES = new Set(['pending', 'delivered', 'acknowledged']);
const TASK_TRANSITIONS = {
  open: new Set(['assigned', 'in_progress', 'blocked', 'cancelled']),
  assigned: new Set(['in_progress', 'blocked', 'cancelled']),
  in_progress: new Set(['blocked', 'completed', 'cancelled']),
  blocked: new Set(['in_progress', 'cancelled']),
  completed: new Set(),
  cancelled: new Set(),
};

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

function eventForHash(row) {
  return {
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
}

function verifyEventRow(row) {
  try {
    const event = eventForHash(row);
    const actual = sha256(event);
    return { valid: actual === row.content_hash, expected: row.content_hash, actual, event };
  } catch (error) {
    return { valid: false, expected: row.content_hash, actual: null, reason: `invalid event encoding: ${error.message}`, event: null };
  }
}

function objectReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const item of value) objectReferences(item, references);
  } else if (value && typeof value === 'object') {
    if (typeof value.objectRef === 'string') references.push({ reference: value.objectRef, bytes: value.bytes });
    else if (typeof value.hash === 'string' && Object.hasOwn(value, 'bytes')) {
      references.push({ reference: value.hash, bytes: value.bytes });
    }
    for (const item of Object.values(value)) objectReferences(item, references);
  }
  return references;
}

function validObjectReference(reference) {
  return /^sha256:[a-f0-9]{64}$/iu.test(reference);
}

function addIssue(issues, issue) {
  if (issues.length < 100) issues.push(issue);
}

function expectedTaskProjection(events, addAuditIssue) {
  const tasks = new Map();
  for (const event of events) {
    const taskId = event?.taskId ?? event?.task_id;
    const createdAt = event?.createdAt ?? event?.created_at;
    const agentId = event?.agentId ?? event?.agent_id;
    if (!taskId || !event.type.startsWith('task.')) continue;
    if (event.type === 'task.created') {
      const { title, description = '', priority = 'normal' } = event.payload ?? {};
      if (typeof title !== 'string' || !title.trim() || typeof description !== 'string' || !TASK_PRIORITIES.has(priority)) {
        addAuditIssue({ kind: 'invalid_task_created', eventId: event.id, taskId });
        continue;
      }
      if (tasks.has(taskId)) {
        addAuditIssue({ kind: 'duplicate_task_created', eventId: event.id, taskId });
        continue;
      }
      tasks.set(taskId, {
        id: taskId,
        title,
        description,
        priority,
        status: 'open',
        createdBy: agentId,
        assigneeId: null,
        blockedReason: null,
        createdEventId: event.id,
        updatedEventId: event.id,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      });
      continue;
    }
    const task = tasks.get(taskId);
    if (!task) {
      addAuditIssue({ kind: 'task_event_missing_task', eventId: event.id, taskId });
      continue;
    }
    if (event.type === 'task.assigned') {
      const assigneeId = event.payload?.assigneeId;
      if (typeof assigneeId !== 'string' || !assigneeId.trim() || task.status === 'completed' || task.status === 'cancelled') {
        addAuditIssue({ kind: 'invalid_task_assignment', eventId: event.id, taskId });
        continue;
      }
      task.assigneeId = assigneeId;
      task.status = task.status === 'open' ? 'assigned' : task.status;
      task.updatedEventId = event.id;
      task.updatedAt = createdAt;
      continue;
    }
    if (event.type === 'task.status_changed') {
      const { status, summary = null } = event.payload ?? {};
      if (!TASK_STATUSES.has(status) || (summary !== null && typeof summary !== 'string') || !TASK_TRANSITIONS[task.status]?.has(status)) {
        addAuditIssue({ kind: 'invalid_task_transition', eventId: event.id, taskId, from: task.status, to: status ?? null });
        continue;
      }
      task.status = status;
      task.blockedReason = status === 'blocked' ? summary : null;
      task.updatedEventId = event.id;
      task.updatedAt = createdAt;
      if (status === 'completed') task.completedAt = createdAt;
    }
  }
  return tasks;
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
    CREATE TABLE IF NOT EXISTS event_order (
      event_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      FOREIGN KEY (event_id) REFERENCES events(id)
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
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      assignee_id TEXT,
      blocked_reason TEXT,
      created_event_id TEXT NOT NULL,
      updated_event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (created_event_id) REFERENCES events(id),
      FOREIGN KEY (updated_event_id) REFERENCES events(id)
    );
    CREATE INDEX IF NOT EXISTS events_task_time ON events(task_id, created_at);
    CREATE INDEX IF NOT EXISTS events_agent_time ON events(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS events_type_time ON events(type, created_at);
    CREATE INDEX IF NOT EXISTS event_order_sequence ON event_order(sequence);
    CREATE INDEX IF NOT EXISTS deliveries_recipient_status ON deliveries(recipient_id, status, created_at);
    CREATE INDEX IF NOT EXISTS tasks_assignee_status ON tasks(assignee_id, status, updated_at);
    CREATE TRIGGER IF NOT EXISTS events_are_immutable_on_update
      BEFORE UPDATE ON events BEGIN
        SELECT RAISE(ABORT, 'events are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS events_are_immutable_on_delete
      BEFORE DELETE ON events BEGIN
        SELECT RAISE(ABORT, 'events are immutable');
      END;
  `);
  ensureEventOrder(database);
  database.prepare(`
    INSERT INTO metadata(key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(SCHEMA_VERSION));
  database.close();
  ensureGitExcludesState(root);
  return { repo: root, database: path.join(directory, 'events.db') };
}

function ensureEventOrder(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS event_order (
      event_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE INDEX IF NOT EXISTS event_order_sequence ON event_order(sequence);
  `);
  database.prepare(`
    INSERT OR IGNORE INTO event_order(event_id, sequence)
    SELECT events.id, events.rowid
    FROM events LEFT JOIN event_order ON event_order.event_id = events.id
    WHERE event_order.event_id IS NULL
    ORDER BY events.rowid ASC
  `).run();
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
    ensureEventOrder(this.database);
  }

  close() {
    this.database.close();
  }

  append(input) {
    const transaction = this.database.transaction(() => this.#insertEvent(input));
    return transaction.immediate();
  }

  createTask({ createdBy, title, description = '', priority = 'normal', sessionId = null }) {
    if (!createdBy?.trim()) throw new Error('createdBy is required');
    if (typeof title !== 'string' || !title.trim()) throw new Error('task title is required');
    if (typeof description !== 'string') throw new Error('task description must be a string');
    if (!TASK_PRIORITIES.has(priority)) throw new Error(`invalid task priority: ${priority}`);
    const taskId = `task_${crypto.randomUUID()}`;
    const event = this.append({
      agentId: createdBy,
      type: 'task.created',
      taskId,
      sessionId,
      ref: `task/${taskId}`,
      payload: { title: title.trim(), description, priority },
    });
    return { task: this.getTask(taskId), event };
  }

  assignTask({ taskId, assignedBy, assigneeId, note = null }) {
    if (!assignedBy?.trim()) throw new Error('assignedBy is required');
    if (!assigneeId?.trim()) throw new Error('assigneeId is required');
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task does not exist: ${taskId}`);
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new Error(`cannot assign a ${task.status} task`);
    }
    const event = this.append({
      agentId: assignedBy,
      type: 'task.assigned',
      taskId,
      ref: `task/${taskId}`,
      payload: { assigneeId: assigneeId.trim(), note },
    });
    return { task: this.getTask(taskId), event };
  }

  updateTaskStatus({ taskId, updatedBy, status, summary = null }) {
    if (!updatedBy?.trim()) throw new Error('updatedBy is required');
    if (!TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
    if (summary !== null && typeof summary !== 'string') throw new Error('summary must be a string or null');
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task does not exist: ${taskId}`);
    this.#assertTaskTransition(task.status, status);
    const event = this.append({
      agentId: updatedBy,
      type: 'task.status_changed',
      taskId,
      ref: `task/${taskId}`,
      payload: { status, summary },
    });
    return { task: this.getTask(taskId), event };
  }

  updateTask({ taskId, updatedBy, assigneeId = null, note = null, status = null, summary = null }) {
    if (!updatedBy?.trim()) throw new Error('updatedBy is required');
    if (assigneeId !== null && !assigneeId?.trim()) throw new Error('assigneeId is required');
    if (status !== null && !TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
    if (summary !== null && typeof summary !== 'string') throw new Error('summary must be a string or null');
    const transaction = this.database.transaction(() => {
      let task = this.getTask(taskId);
      if (!task) throw new Error(`task does not exist: ${taskId}`);
      if (assigneeId !== null) {
        if (task.status === 'completed' || task.status === 'cancelled') throw new Error(`cannot assign a ${task.status} task`);
        this.#insertEvent({
          agentId: updatedBy,
          type: 'task.assigned',
          taskId,
          ref: `task/${taskId}`,
          payload: { assigneeId: assigneeId.trim(), note },
        });
        task = this.getTask(taskId);
      }
      if (status !== null) {
        this.#assertTaskTransition(task.status, status);
        this.#insertEvent({
          agentId: updatedBy,
          type: 'task.status_changed',
          taskId,
          ref: `task/${taskId}`,
          payload: { status, summary },
        });
      }
      return this.getTask(taskId);
    });
    return transaction.immediate();
  }

  getTask(taskId) {
    const row = this.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    return row ? this.#hydrateTask(row) : null;
  }

  listTasks({ assigneeId = null, status = null, limit = 100 } = {}) {
    if (status !== null && !TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
    const clauses = [];
    const values = [];
    if (assigneeId) { clauses.push('assignee_id = ?'); values.push(assigneeId); }
    if (status) { clauses.push('status = ?'); values.push(status); }
    values.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.database.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC, task_id ASC LIMIT ?`)
      .all(...values).map((row) => this.#hydrateTask(row));
  }

  rebuildTaskProjection() {
    const transaction = this.database.transaction(() => {
      this.database.prepare('DELETE FROM tasks').run();
      const rows = this.database.prepare(`
        SELECT events.*, event_order.sequence AS event_sequence
        FROM events JOIN event_order ON event_order.event_id = events.id
        WHERE type IN ('task.created', 'task.assigned', 'task.status_changed')
      `).all().map((row) => ({ ...this.#hydrate(row), eventSequence: row.event_sequence }));
      const pending = new Map(rows.map((event) => [event.id, event]));
      while (pending.size > 0) {
        const ready = [...pending.values()].filter((event) => event.parents.every((parent) => !pending.has(parent)));
        if (ready.length === 0) throw new Error('task event history has a causal cycle');
        ready.sort((left, right) => left.eventSequence - right.eventSequence);
        for (const event of ready) {
          this.#projectTaskEvent(event);
          pending.delete(event.id);
        }
      }
      return rows.length;
    });
    return transaction.immediate();
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
    return transaction.immediate();
  }

  sendMessage({ from, to, text, subject = null, taskId = null, sessionId = null, ref = null, causationId = null, references = [] }) {
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
        causationId,
        payload: { to: cleanedRecipients, subject, text, references },
      });
      const insert = this.database.prepare(`
        INSERT INTO deliveries(event_id, recipient_id, status, created_at)
        VALUES (?, ?, 'pending', ?)
      `);
      for (const recipient of cleanedRecipients) insert.run(event.id, recipient, event.createdAt);
      return event;
    });
    return transaction.immediate();
  }

  inbox({ agentId, status = null, limit = 100 } = {}) {
    if (!agentId?.trim()) throw new Error('agentId is required');
    if (status !== null && !DELIVERY_STATUSES.has(status)) throw new Error(`invalid delivery status: ${status}`);
    const values = [agentId];
    const condition = status ? 'AND d.status = ?' : '';
    if (status) values.push(status);
    values.push(limit);
    return this.database.prepare(`
      SELECT e.*, d.recipient_id, d.status AS delivery_status, d.created_at AS delivery_created_at,
        d.delivered_at, d.acknowledged_at
      FROM deliveries d
      JOIN events e ON e.id = d.event_id
      JOIN event_order o ON o.event_id = e.id
      WHERE d.recipient_id = ? ${condition}
      ORDER BY o.sequence ASC LIMIT ?
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

  receiveInbox({ agentId, status = null, limit = 100 } = {}) {
    const transaction = this.database.transaction(() => {
      const messages = this.inbox({ agentId, status, limit });
      const deliveredAt = now();
      const markDelivered = this.database.prepare(`
        UPDATE deliveries SET status = 'delivered', delivered_at = ?
        WHERE event_id = ? AND recipient_id = ? AND status = 'pending'
      `);
      return messages.map((message) => {
        if (message.delivery.status !== 'pending') return message;
        const changed = markDelivered.run(deliveredAt, message.id, agentId).changes;
        if (changed === 0) {
          const delivery = this.delivery(message.id, agentId);
          return { ...message, delivery };
        }
        return {
          ...message,
          delivery: { ...message.delivery, status: 'delivered', deliveredAt },
        };
      });
    });
    return transaction.immediate();
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
      this.database.prepare(`
        INSERT INTO event_order(event_id, sequence)
        SELECT ?, COALESCE(MAX(sequence), 0) + 1 FROM event_order
      `).run(event.id);
      const result = {
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
      this.#projectTaskEvent(result);
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
      return result;
    }
  }

  #projectTaskEvent(event) {
    if (!event.taskId || !event.type.startsWith('task.')) return;
    if (event.type === 'task.created') {
      const { title, description = '', priority = 'normal' } = event.payload;
      if (typeof title !== 'string' || !title.trim()) throw new Error('task.created requires a non-empty title');
      if (typeof description !== 'string') throw new Error('task.created description must be a string');
      if (!TASK_PRIORITIES.has(priority)) throw new Error(`invalid task priority: ${priority}`);
      this.database.prepare(`
        INSERT INTO tasks(task_id, title, description, priority, status, created_by, created_event_id,
          updated_event_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
      `).run(event.taskId, title, description, priority, event.agentId, event.id, event.id, event.createdAt, event.createdAt);
      return;
    }
    const task = this.getTask(event.taskId);
    if (!task) throw new Error(`${event.type} references missing task: ${event.taskId}`);
    if (event.type === 'task.assigned') {
      const { assigneeId } = event.payload;
      if (typeof assigneeId !== 'string' || !assigneeId.trim()) throw new Error('task.assigned requires assigneeId');
      if (task.status === 'completed' || task.status === 'cancelled') throw new Error(`cannot assign a ${task.status} task`);
      const nextStatus = task.status === 'open' ? 'assigned' : task.status;
      this.database.prepare(`
        UPDATE tasks SET assignee_id = ?, status = ?, updated_event_id = ?, updated_at = ? WHERE task_id = ?
      `).run(assigneeId, nextStatus, event.id, event.createdAt, event.taskId);
      return;
    }
    if (event.type === 'task.status_changed') {
      const { status, summary = null } = event.payload;
      if (!TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
      if (summary !== null && typeof summary !== 'string') throw new Error('task.status_changed summary must be a string or null');
      this.#assertTaskTransition(task.status, status);
      this.database.prepare(`
        UPDATE tasks SET status = ?, blocked_reason = ?, updated_event_id = ?, updated_at = ?,
          completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
        WHERE task_id = ?
      `).run(status, status === 'blocked' ? summary : null, event.id, event.createdAt, status, event.createdAt, event.taskId);
    }
  }

  #assertTaskTransition(current, next) {
    if (current === next) throw new Error(`task is already ${next}`);
    if (!TASK_TRANSITIONS[current]?.has(next)) throw new Error(`invalid task transition: ${current} -> ${next}`);
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
        SELECT events.* FROM events
        JOIN history ON history.id = events.id
        JOIN event_order ON event_order.event_id = events.id
        ORDER BY event_order.sequence ASC LIMIT ?
      `).all(row.event_id, limit);
      return rows.map((item) => this.#hydrate(item));
    }
    if (taskId) { conditions.push('task_id = ?'); values.push(taskId); }
    if (agentId) { conditions.push('agent_id = ?'); values.push(agentId); }
    if (type) { conditions.push('type = ?'); values.push(type); }
    values.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.database.prepare(`
      SELECT events.* FROM events JOIN event_order ON event_order.event_id = events.id
      ${where} ORDER BY event_order.sequence ASC LIMIT ?
    `)
      .all(...values).map((item) => this.#hydrate(item));
  }

  recentEvents({ limit = 200 } = {}) {
    return this.database.prepare(`
      SELECT events.* FROM events JOIN event_order ON event_order.event_id = events.id
      ORDER BY event_order.sequence DESC LIMIT ?
    `)
      .all(limit).map((item) => this.#hydrate(item));
  }

  dashboardSummary() {
    const tasks = Object.fromEntries(this.database.prepare(`
      SELECT status, COUNT(*) AS count FROM tasks GROUP BY status
    `).all().map((row) => [row.status, row.count]));
    const deliveries = Object.fromEntries(this.database.prepare(`
      SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status
    `).all().map((row) => [row.status, row.count]));
    const agents = this.database.prepare('SELECT COUNT(DISTINCT agent_id) AS count FROM events').get().count;
    const events = this.database.prepare('SELECT COUNT(*) AS count FROM events').get().count;
    return { tasks, deliveries, agents, events };
  }

  refs() {
    return this.database.prepare('SELECT name, event_id, updated_at FROM refs ORDER BY name').all();
  }

  verify(eventId) {
    const row = this.database.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!row) return { valid: false, reason: 'event not found' };
    const result = verifyEventRow(row);
    return { valid: result.valid, expected: result.expected, actual: result.actual, ...(result.reason ? { reason: result.reason } : {}) };
  }

  verifyAll() {
    const issues = [];
    const checked = { events: 0, eventOrder: 0, refs: 0, deliveries: 0, objects: 0, sourceEvents: 0, tasks: 0 };
    const rows = this.database.prepare(`
      SELECT events.*, event_order.sequence AS event_sequence
      FROM events LEFT JOIN event_order ON event_order.event_id = events.id
      ORDER BY event_order.sequence ASC, events.rowid ASC
    `).all();
    const events = new Map();
    const orderedEvents = [];
    let previousSequence = 0;
    for (const row of rows) {
      checked.events += 1;
      const result = verifyEventRow(row);
      if (!result.valid) addIssue(issues, {
        kind: 'event_hash_mismatch', eventId: row.id, expected: result.expected, actual: result.actual, reason: result.reason,
      });
      events.set(row.id, result.event);
      if (result.event) orderedEvents.push(result.event);
      checked.eventOrder += 1;
      if (!Number.isInteger(row.event_sequence)) {
        addIssue(issues, { kind: 'event_order_missing', eventId: row.id });
      } else if (row.event_sequence <= previousSequence) {
        addIssue(issues, { kind: 'event_order_invalid', eventId: row.id, sequence: row.event_sequence });
      } else {
        previousSequence = row.event_sequence;
      }
    }

    for (const row of this.database.prepare(`
      SELECT event_order.event_id FROM event_order
      LEFT JOIN events ON events.id = event_order.event_id
      WHERE events.id IS NULL
    `).all()) {
      addIssue(issues, { kind: 'event_order_orphan', eventId: row.event_id });
    }

    const visiting = new Set();
    const visited = new Set();
    const visit = (eventId) => {
      if (visited.has(eventId)) return;
      if (visiting.has(eventId)) {
        addIssue(issues, { kind: 'causal_cycle', eventId });
        return;
      }
      const event = events.get(eventId);
      if (!event) return;
      visiting.add(eventId);
      const parents = Array.isArray(event.parents) ? event.parents : null;
      if (!parents) {
        addIssue(issues, { kind: 'invalid_parents', eventId });
      } else {
        for (const parent of parents) {
          if (!events.has(parent)) addIssue(issues, { kind: 'missing_parent', eventId, parentId: parent });
          else visit(parent);
        }
      }
      if (event.causation_id) {
        if (!events.has(event.causation_id)) addIssue(issues, { kind: 'missing_causation', eventId, causationId: event.causation_id });
        else visit(event.causation_id);
      }
      visiting.delete(eventId);
      visited.add(eventId);
    };
    for (const eventId of events.keys()) visit(eventId);

    for (const ref of this.refs()) {
      checked.refs += 1;
      if (ref.event_id !== null && !events.has(ref.event_id)) addIssue(issues, { kind: 'ref_missing_event', ref: ref.name, eventId: ref.event_id });
    }

    const deliveries = new Map();
    for (const delivery of this.database.prepare('SELECT event_id, recipient_id, status FROM deliveries').all()) {
      checked.deliveries += 1;
      if (!events.has(delivery.event_id)) {
        addIssue(issues, { kind: 'delivery_missing_event', eventId: delivery.event_id, recipientId: delivery.recipient_id });
        continue;
      }
      const recipients = deliveries.get(delivery.event_id) ?? [];
      recipients.push(delivery.recipient_id);
      deliveries.set(delivery.event_id, recipients);
      if (!DELIVERY_STATUSES.has(delivery.status)) addIssue(issues, { kind: 'invalid_delivery_status', eventId: delivery.event_id, recipientId: delivery.recipient_id });
    }
    for (const [eventId, event] of events) {
      const recipients = deliveries.get(eventId) ?? [];
      if (!event || event.type !== 'message.sent') {
        if (recipients.length > 0) addIssue(issues, { kind: 'delivery_for_non_message', eventId });
        continue;
      }
      const declared = event.payload?.to;
      if (!Array.isArray(declared) || declared.some((recipient) => typeof recipient !== 'string' || !recipient.trim())) {
        addIssue(issues, { kind: 'invalid_message_recipients', eventId });
        continue;
      }
      const expected = [...new Set(declared)].sort();
      const actual = [...new Set(recipients)].sort();
      if (expected.length !== actual.length || expected.some((recipient, index) => recipient !== actual[index])) {
        addIssue(issues, { kind: 'delivery_recipients_mismatch', eventId, expected, actual });
      }
    }

    const references = new Map();
    for (const [eventId, event] of events) {
      if (!event) continue;
      for (const reference of objectReferences(event.payload)) {
        const entries = references.get(reference.reference) ?? [];
        entries.push({ eventId, bytes: reference.bytes });
        references.set(reference.reference, entries);
      }
    }
    for (const [reference, uses] of references) {
      checked.objects += 1;
      if (!validObjectReference(reference)) {
        addIssue(issues, { kind: 'invalid_object_reference', reference, eventIds: uses.map((use) => use.eventId) });
        continue;
      }
      let content;
      try { content = readObject(this.repo, reference); } catch {
        addIssue(issues, { kind: 'object_missing', reference, eventIds: uses.map((use) => use.eventId) });
        continue;
      }
      const actual = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
      if (actual !== reference) addIssue(issues, { kind: 'object_hash_mismatch', reference, actual, eventIds: uses.map((use) => use.eventId) });
      for (const use of uses) {
        if (Number.isInteger(use.bytes) && use.bytes !== content.length) {
          addIssue(issues, { kind: 'object_size_mismatch', reference, eventId: use.eventId, expected: use.bytes, actual: content.length });
        }
      }
    }

    for (const source of this.database.prepare(`
      SELECT source_events.source_key, source_events.source_offset, source_events.event_id, events.id AS existing_event_id
      FROM source_events LEFT JOIN events ON events.id = source_events.event_id
    `).all()) {
      checked.sourceEvents += 1;
      if (!source.existing_event_id) {
        addIssue(issues, { kind: 'source_event_missing', sourceKey: source.source_key, sourceOffset: source.source_offset, eventId: source.event_id });
      }
    }

    const expectedTasks = expectedTaskProjection(orderedEvents, (issue) => addIssue(issues, issue));
    const projectedTasks = new Map(this.database.prepare('SELECT * FROM tasks').all().map((row) => [row.task_id, this.#hydrateTask(row)]));
    for (const [taskId, expected] of expectedTasks) {
      checked.tasks += 1;
      const actual = projectedTasks.get(taskId);
      if (!actual) {
        addIssue(issues, { kind: 'task_projection_missing', taskId });
        continue;
      }
      const fields = ['title', 'description', 'priority', 'status', 'createdBy', 'assigneeId', 'blockedReason', 'createdEventId', 'updatedEventId', 'createdAt', 'updatedAt', 'completedAt'];
      const mismatches = fields.filter((field) => actual[field] !== expected[field]);
      if (mismatches.length > 0) addIssue(issues, { kind: 'task_projection_mismatch', taskId, fields: mismatches });
    }
    for (const taskId of projectedTasks.keys()) {
      if (!expectedTasks.has(taskId)) checked.tasks += 1;
      if (!expectedTasks.has(taskId)) addIssue(issues, { kind: 'task_projection_orphan', taskId });
    }
    return { valid: issues.length === 0, checked, issues };
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

  #hydrateTask(row) {
    return {
      id: row.task_id,
      title: row.title,
      description: row.description,
      priority: row.priority,
      status: row.status,
      createdBy: row.created_by,
      assigneeId: row.assignee_id,
      blockedReason: row.blocked_reason,
      createdEventId: row.created_event_id,
      updatedEventId: row.updated_event_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }
}
