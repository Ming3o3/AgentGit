// src/index.mjs
import Schema from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

// ../../src/store.mjs
import fs2 from "node:fs";
import path2 from "node:path";
import crypto3 from "node:crypto";
import { execFileSync } from "node:child_process";

// ../../src/objects.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
function normalizeHash(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw new Error("invalid object hash");
  }
  return value.toLowerCase();
}
function objectPath(repo, hash) {
  const normalized = normalizeHash(hash);
  return path.join(path.resolve(repo), ".agentgit", "objects", normalized.slice(0, 2), normalized.slice(2));
}
function putObject(repo, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const destination = objectPath(repo, hash);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.writeFileSync(destination, bytes, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return { hash: `sha256:${hash}`, bytes: bytes.length };
}
function readObject(repo, reference) {
  if (typeof reference !== "string") throw new Error("invalid object reference");
  const hash = normalizeHash(reference.replace(/^sha256:/iu, ""));
  return fs.readFileSync(objectPath(repo, hash));
}

// ../../src/payload.mjs
var INLINE_LIMIT = 8192;
var SENSITIVE_KEY_SOURCE = "api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|token|client[_-]?secret|refresh[_-]?token|private[_-]?key";
var SENSITIVE_KEYS = new RegExp(`^(?:${SENSITIVE_KEY_SOURCE})$`, "iu");
var SECRET_PATTERNS = [
  new RegExp(`(["']?\\b(?:${SENSITIVE_KEY_SOURCE})\\b["']?\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`, "giu"),
  new RegExp(`(["']?\\b(?:${SENSITIVE_KEY_SOURCE})\\b["']?\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`, "giu"),
  new RegExp(`(["']?\\b(?:${SENSITIVE_KEY_SOURCE})\\b["']?\\s*[:=])((?!\\s*["'])\\s*)[^\\r\\n,;}]+`, "giu"),
  /\bBearer\s+[A-Za-z0-9._~+\-/=]{12,}/gu,
  /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,})\b/gu
];
function redactText(text) {
  let result = text;
  result = result.replace(SECRET_PATTERNS[0], '$1"[REDACTED]"');
  result = result.replace(SECRET_PATTERNS[1], "$1'[REDACTED]'");
  result = result.replace(SECRET_PATTERNS[2], "$1$2[REDACTED]");
  result = result.replace(SECRET_PATTERNS[3], "Bearer [REDACTED]");
  result = result.replace(SECRET_PATTERNS[4], "[REDACTED]");
  return result;
}
function sanitizePayload(value, repo, key = null) {
  if (key !== null && SENSITIVE_KEYS.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    const safe = redactText(value);
    if (Buffer.byteLength(safe, "utf8") <= INLINE_LIMIT) return safe;
    const object = putObject(repo, safe);
    return {
      objectRef: object.hash,
      bytes: object.bytes,
      preview: `${safe.slice(0, 512)}\u2026`
    };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item, repo));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, sanitizePayload(item, repo, childKey)]));
  }
  return value;
}

// ../../src/store.mjs
import Database from "better-sqlite3";

// ../../src/canonical-json.mjs
import crypto2 from "node:crypto";
function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
function sha256(value) {
  return crypto2.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// ../../src/store.mjs
var SCHEMA_VERSION = 3;
var TASK_STATUSES = /* @__PURE__ */ new Set(["open", "assigned", "in_progress", "blocked", "completed", "cancelled"]);
var TASK_PRIORITIES = /* @__PURE__ */ new Set(["low", "normal", "high", "urgent"]);
var DELIVERY_STATUSES = /* @__PURE__ */ new Set(["pending", "delivered", "acknowledged"]);
var TASK_TRANSITIONS = {
  open: /* @__PURE__ */ new Set(["assigned", "in_progress", "blocked", "cancelled"]),
  assigned: /* @__PURE__ */ new Set(["in_progress", "blocked", "cancelled"]),
  in_progress: /* @__PURE__ */ new Set(["blocked", "completed", "cancelled"]),
  blocked: /* @__PURE__ */ new Set(["in_progress", "cancelled"]),
  completed: /* @__PURE__ */ new Set(),
  cancelled: /* @__PURE__ */ new Set()
};
var MAX_QUERY_LIMIT = 1e4;
var SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: "event-history",
    apply(database) {
      database.exec(`
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
      `);
    }
  },
  {
    version: 2,
    name: "projections-and-ingest",
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS event_order (
          event_id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE,
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
        CREATE INDEX IF NOT EXISTS event_order_sequence ON event_order(sequence);
        CREATE INDEX IF NOT EXISTS deliveries_recipient_status ON deliveries(recipient_id, status, created_at);
        CREATE INDEX IF NOT EXISTS tasks_assignee_status ON tasks(assignee_id, status, updated_at);
      `);
    }
  },
  {
    version: 3,
    name: "cursor-prefix-fingerprints",
    apply(database) {
      database.exec("ALTER TABLE ingest_cursors ADD COLUMN prefix_hash TEXT");
    }
  }
];
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function id() {
  return `evt_${crypto3.randomUUID()}`;
}
function parseJson(value, fallback) {
  if (value === null || value === void 0 || value === "") return fallback;
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
    created_at: row.created_at
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
  } else if (value && typeof value === "object") {
    if (typeof value.objectRef === "string") references.push({ reference: value.objectRef, bytes: value.bytes });
    else if (typeof value.hash === "string" && Object.hasOwn(value, "bytes")) {
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
function assertSupportedSchema(database) {
  const hasMetadata = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
  if (!hasMetadata) return;
  const recordedVersion = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value;
  if (recordedVersion === void 0) return;
  const parsedVersion = Number(recordedVersion);
  if (!Number.isInteger(parsedVersion) || parsedVersion < 0 || parsedVersion > SCHEMA_VERSION) {
    throw new Error(`unsupported AgentGit schema version: ${recordedVersion}`);
  }
}
function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`);
  }
  return limit;
}
function expectedTaskProjection(events, addAuditIssue) {
  const tasks = /* @__PURE__ */ new Map();
  for (const event of events) {
    const taskId = event?.taskId ?? event?.task_id;
    const createdAt = event?.createdAt ?? event?.created_at;
    const agentId = event?.agentId ?? event?.agent_id;
    if (!taskId || typeof event?.type !== "string" || !event.type.startsWith("task.")) continue;
    if (event.type === "task.created") {
      const { title, description = "", priority = "normal" } = event.payload ?? {};
      if (typeof title !== "string" || !title.trim() || typeof description !== "string" || !TASK_PRIORITIES.has(priority)) {
        addAuditIssue({ kind: "invalid_task_created", eventId: event.id, taskId });
        continue;
      }
      if (tasks.has(taskId)) {
        addAuditIssue({ kind: "duplicate_task_created", eventId: event.id, taskId });
        continue;
      }
      tasks.set(taskId, {
        id: taskId,
        title,
        description,
        priority,
        status: "open",
        createdBy: agentId,
        assigneeId: null,
        blockedReason: null,
        createdEventId: event.id,
        updatedEventId: event.id,
        createdAt,
        updatedAt: createdAt,
        completedAt: null
      });
      continue;
    }
    const task = tasks.get(taskId);
    if (!task) {
      addAuditIssue({ kind: "task_event_missing_task", eventId: event.id, taskId });
      continue;
    }
    if (event.type === "task.assigned") {
      const assigneeId = event.payload?.assigneeId;
      if (typeof assigneeId !== "string" || !assigneeId.trim() || task.status === "completed" || task.status === "cancelled") {
        addAuditIssue({ kind: "invalid_task_assignment", eventId: event.id, taskId });
        continue;
      }
      task.assigneeId = assigneeId;
      task.status = task.status === "open" ? "assigned" : task.status;
      task.updatedEventId = event.id;
      task.updatedAt = createdAt;
      continue;
    }
    if (event.type === "task.status_changed") {
      const { status, summary = null } = event.payload ?? {};
      if (!TASK_STATUSES.has(status) || summary !== null && typeof summary !== "string" || !TASK_TRANSITIONS[task.status]?.has(status)) {
        addAuditIssue({ kind: "invalid_task_transition", eventId: event.id, taskId, from: task.status, to: status ?? null });
        continue;
      }
      task.status = status;
      task.blockedReason = status === "blocked" ? summary : null;
      task.updatedEventId = event.id;
      task.updatedAt = createdAt;
      if (status === "completed") task.completedAt = createdAt;
    }
  }
  return tasks;
}
function repoDbPath(repo) {
  return path2.join(path2.resolve(repo), ".agentgit", "events.db");
}
function migrateDatabase(database) {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const migrate = database.transaction(() => {
    const recordedVersion = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get()?.value;
    const currentVersion = recordedVersion === void 0 ? 0 : Number(recordedVersion);
    assertSupportedSchema(database);
    for (const migration of SCHEMA_MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      migration.apply(database);
      database.prepare(`
        INSERT INTO metadata(key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(String(migration.version));
    }
  });
  migrate.immediate();
  ensureEventOrder(database);
}
function initRepository(repo) {
  const root = path2.resolve(repo);
  const directory = path2.join(root, ".agentgit");
  fs2.mkdirSync(directory, { recursive: true });
  const database = new Database(path2.join(directory, "events.db"));
  try {
    migrateDatabase(database);
  } finally {
    database.close();
  }
  ensureGitExcludesState(root);
  return { repo: root, database: path2.join(directory, "events.db") };
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
    excludePath = execFileSync("git", ["-C", root, "rev-parse", "--git-path", "info/exclude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return;
  }
  if (!path2.isAbsolute(excludePath)) excludePath = path2.resolve(root, excludePath);
  fs2.mkdirSync(path2.dirname(excludePath), { recursive: true });
  const current = fs2.existsSync(excludePath) ? fs2.readFileSync(excludePath, "utf8") : "";
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(".agentgit/")) {
    fs2.appendFileSync(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}.agentgit/
`);
  }
}
var EventStore = class {
  constructor(repo) {
    this.repo = path2.resolve(repo);
    fs2.mkdirSync(path2.join(this.repo, ".agentgit"), { recursive: true });
    this.database = new Database(repoDbPath(this.repo));
    try {
      migrateDatabase(this.database);
      ensureGitExcludesState(this.repo);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }
  close() {
    this.database.close();
  }
  append(input) {
    const transaction = this.database.transaction(() => this.#insertEvent(input));
    return transaction.immediate();
  }
  createTask({ createdBy, title, description = "", priority = "normal", sessionId = null }) {
    if (!createdBy?.trim()) throw new Error("createdBy is required");
    if (typeof title !== "string" || !title.trim()) throw new Error("task title is required");
    if (typeof description !== "string") throw new Error("task description must be a string");
    if (!TASK_PRIORITIES.has(priority)) throw new Error(`invalid task priority: ${priority}`);
    const taskId = `task_${crypto3.randomUUID()}`;
    const event = this.append({
      agentId: createdBy,
      type: "task.created",
      taskId,
      sessionId,
      ref: `task/${taskId}`,
      payload: { title: title.trim(), description, priority }
    });
    return { task: this.getTask(taskId), event };
  }
  assignTask({ taskId, assignedBy, assigneeId, note = null }) {
    if (!assignedBy?.trim()) throw new Error("assignedBy is required");
    if (!assigneeId?.trim()) throw new Error("assigneeId is required");
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task does not exist: ${taskId}`);
    if (task.status === "completed" || task.status === "cancelled") {
      throw new Error(`cannot assign a ${task.status} task`);
    }
    const event = this.append({
      agentId: assignedBy,
      type: "task.assigned",
      taskId,
      ref: `task/${taskId}`,
      payload: { assigneeId: assigneeId.trim(), note }
    });
    return { task: this.getTask(taskId), event };
  }
  updateTaskStatus({ taskId, updatedBy, status, summary = null }) {
    if (!updatedBy?.trim()) throw new Error("updatedBy is required");
    if (!TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
    if (summary !== null && typeof summary !== "string") throw new Error("summary must be a string or null");
    const task = this.getTask(taskId);
    if (!task) throw new Error(`task does not exist: ${taskId}`);
    this.#assertTaskTransition(task.status, status);
    const event = this.append({
      agentId: updatedBy,
      type: "task.status_changed",
      taskId,
      ref: `task/${taskId}`,
      payload: { status, summary }
    });
    return { task: this.getTask(taskId), event };
  }
  updateTask({ taskId, updatedBy, assigneeId = null, note = null, status = null, summary = null }) {
    if (!updatedBy?.trim()) throw new Error("updatedBy is required");
    if (assigneeId !== null && !assigneeId?.trim()) throw new Error("assigneeId is required");
    if (status !== null && !TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
    if (summary !== null && typeof summary !== "string") throw new Error("summary must be a string or null");
    const transaction = this.database.transaction(() => {
      let task = this.getTask(taskId);
      if (!task) throw new Error(`task does not exist: ${taskId}`);
      if (assigneeId !== null) {
        if (task.status === "completed" || task.status === "cancelled") throw new Error(`cannot assign a ${task.status} task`);
        this.#insertEvent({
          agentId: updatedBy,
          type: "task.assigned",
          taskId,
          ref: `task/${taskId}`,
          payload: { assigneeId: assigneeId.trim(), note }
        });
        task = this.getTask(taskId);
      }
      if (status !== null) {
        this.#assertTaskTransition(task.status, status);
        this.#insertEvent({
          agentId: updatedBy,
          type: "task.status_changed",
          taskId,
          ref: `task/${taskId}`,
          payload: { status, summary }
        });
      }
      return this.getTask(taskId);
    });
    return transaction.immediate();
  }
  getTask(taskId) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
    return row ? this.#hydrateTask(row) : null;
  }
  listTasks({ assigneeId = null, status = null, limit = 100 } = {}) {
    if (status !== null && !TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
    validateLimit(limit);
    const clauses = [];
    const values = [];
    if (assigneeId) {
      clauses.push("assignee_id = ?");
      values.push(assigneeId);
    }
    if (status) {
      clauses.push("status = ?");
      values.push(status);
    }
    values.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC, task_id ASC LIMIT ?`).all(...values).map((row) => this.#hydrateTask(row));
  }
  rebuildTaskProjection() {
    const transaction = this.database.transaction(() => {
      this.database.prepare("DELETE FROM tasks").run();
      const rows = this.database.prepare(`
        SELECT events.*, event_order.sequence AS event_sequence
        FROM events JOIN event_order ON event_order.event_id = events.id
        WHERE type IN ('task.created', 'task.assigned', 'task.status_changed')
      `).all().map((row) => ({ ...this.#hydrate(row), eventSequence: row.event_sequence }));
      const pending = new Map(rows.map((event) => [event.id, event]));
      while (pending.size > 0) {
        const ready = [...pending.values()].filter((event) => event.parents.every((parent) => !pending.has(parent)));
        if (ready.length === 0) throw new Error("task event history has a causal cycle");
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
  importJsonl({ filePath, agentId, taskId = null, sessionId = null, ref = null, sourceKey = `jsonl:${path2.resolve(filePath)}`, adapter }) {
    const absolutePath = path2.resolve(filePath);
    const bytes = fs2.readFileSync(absolutePath);
    const completeEnd = bytes.lastIndexOf(10, bytes.length - 1) + 1;
    const transaction = this.database.transaction(() => {
      const cursor = this.database.prepare("SELECT byte_offset, prefix_hash FROM ingest_cursors WHERE source_key = ?").get(sourceKey);
      const currentPrefixHash = cursor?.prefix_hash && cursor.byte_offset <= bytes.length ? crypto3.createHash("sha256").update(bytes.subarray(0, cursor.byte_offset)).digest("hex") : null;
      const rewound = Boolean(cursor && (cursor.byte_offset > bytes.length || completeEnd < cursor.byte_offset || cursor.prefix_hash && currentPrefixHash !== cursor.prefix_hash));
      const startOffset = cursor && !rewound ? cursor.byte_offset : 0;
      const completeBytes = bytes.subarray(startOffset, completeEnd);
      if (completeBytes.length === 0 && !rewound) return { imported: 0, skipped: 0, offset: startOffset };
      if (rewound) {
        this.database.prepare("DELETE FROM source_events WHERE source_key = ?").run(sourceKey);
        this.database.prepare("DELETE FROM ingest_cursors WHERE source_key = ?").run(sourceKey);
      }
      let imported = 0;
      let skipped = 0;
      let offset = startOffset;
      const prefixHasher = crypto3.createHash("sha256").update(bytes.subarray(0, startOffset));
      const prefixHash = () => prefixHasher.copy().digest("hex");
      for (const lineBytes of completeBytes.toString("utf8").split("\n").slice(0, -1)) {
        const lineStart = offset;
        offset += Buffer.byteLength(`${lineBytes}
`);
        prefixHasher.update(bytes.subarray(lineStart, offset));
        let raw;
        try {
          raw = JSON.parse(lineBytes);
        } catch {
          skipped += 1;
          this.#advanceCursor(sourceKey, absolutePath, offset, prefixHash());
          continue;
        }
        let normalized;
        try {
          normalized = adapter(raw);
        } catch {
          skipped += 1;
          this.#advanceCursor(sourceKey, absolutePath, offset, prefixHash());
          continue;
        }
        if (!normalized) {
          skipped += 1;
          this.#advanceCursor(sourceKey, absolutePath, offset, prefixHash());
          continue;
        }
        this.#insertEvent({
          agentId,
          type: normalized.type,
          payload: normalized.payload,
          taskId,
          sessionId,
          ref,
          source: {
            adapter: normalized.adapter ?? "jsonl",
            path: absolutePath,
            byteOffset: lineStart,
            rawType: raw.type ?? null,
            payloadType: raw.payload?.type ?? null
          },
          ingest: { sourceKey, sourceOffset: lineStart, filePath: absolutePath, nextOffset: offset, prefixHash: prefixHash() }
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
    if (cleanedRecipients.length === 0) throw new Error("at least one recipient is required");
    if (typeof text !== "string" || !text.trim()) throw new Error("message text is required");
    if (!Array.isArray(references)) throw new Error("references must be an array");
    const transaction = this.database.transaction(() => {
      const event = this.#insertEvent({
        agentId: from,
        type: "message.sent",
        taskId,
        sessionId,
        ref,
        causationId,
        payload: { to: cleanedRecipients, subject, text, references }
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
    if (!agentId?.trim()) throw new Error("agentId is required");
    if (status !== null && !DELIVERY_STATUSES.has(status)) throw new Error(`invalid delivery status: ${status}`);
    validateLimit(limit);
    const values = [agentId];
    const condition = status ? "AND d.status = ?" : "";
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
        acknowledgedAt: row.acknowledged_at
      }
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
        if (message.delivery.status !== "pending") return message;
        const changed = markDelivered.run(deliveredAt, message.id, agentId).changes;
        if (changed === 0) {
          const delivery = this.delivery(message.id, agentId);
          return { ...message, delivery };
        }
        return {
          ...message,
          delivery: { ...message.delivery, status: "delivered", deliveredAt }
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
    const row = this.database.prepare("SELECT * FROM deliveries WHERE event_id = ? AND recipient_id = ?").get(eventId, recipientId);
    return row ? {
      eventId: row.event_id,
      recipientId: row.recipient_id,
      status: row.status,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      acknowledgedAt: row.acknowledged_at
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
      createdAt = now()
    } = input;
    if (!agentId?.trim()) throw new Error("agentId is required");
    if (!type?.trim()) throw new Error("type is required");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("payload must be a JSON object");
    }
    const { ingest = null } = input;
    if (ingest) {
      const existing = this.database.prepare("SELECT event_id FROM source_events WHERE source_key = ? AND source_offset = ?").get(ingest.sourceKey, ingest.sourceOffset);
      if (existing) {
        this.#advanceCursor(ingest.sourceKey, ingest.filePath, ingest.nextOffset, ingest.prefixHash);
        return this.get(existing.event_id);
      }
    }
    {
      const refRow = ref ? this.database.prepare("SELECT event_id FROM refs WHERE name = ?").get(ref) : null;
      const resolvedParents = parents ?? (refRow?.event_id ? [refRow.event_id] : []);
      for (const parent of resolvedParents) {
        if (!this.database.prepare("SELECT 1 FROM events WHERE id = ?").get(parent)) {
          throw new Error(`parent event does not exist: ${parent}`);
        }
      }
      if (causationId && !this.database.prepare("SELECT 1 FROM events WHERE id = ?").get(causationId)) {
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
        created_at: createdAt
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
        content_hash: contentHash
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
        contentHash
      };
      this.#projectTaskEvent(result);
      if (ref) {
        this.database.prepare(`
          INSERT INTO refs(name, event_id, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET event_id=excluded.event_id, updated_at=excluded.updated_at
        `).run(ref, event.id, now());
      }
      if (ingest) {
        this.database.prepare("INSERT INTO source_events(source_key, source_offset, event_id) VALUES (?, ?, ?)").run(ingest.sourceKey, ingest.sourceOffset, event.id);
        this.#advanceCursor(ingest.sourceKey, ingest.filePath, ingest.nextOffset, ingest.prefixHash);
      }
      return result;
    }
  }
  #projectTaskEvent(event) {
    if (!event.taskId || !event.type.startsWith("task.")) return;
    if (event.type === "task.created") {
      const { title, description = "", priority = "normal" } = event.payload;
      if (typeof title !== "string" || !title.trim()) throw new Error("task.created requires a non-empty title");
      if (typeof description !== "string") throw new Error("task.created description must be a string");
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
    if (event.type === "task.assigned") {
      const { assigneeId } = event.payload;
      if (typeof assigneeId !== "string" || !assigneeId.trim()) throw new Error("task.assigned requires assigneeId");
      if (task.status === "completed" || task.status === "cancelled") throw new Error(`cannot assign a ${task.status} task`);
      const nextStatus = task.status === "open" ? "assigned" : task.status;
      this.database.prepare(`
        UPDATE tasks SET assignee_id = ?, status = ?, updated_event_id = ?, updated_at = ? WHERE task_id = ?
      `).run(assigneeId, nextStatus, event.id, event.createdAt, event.taskId);
      return;
    }
    if (event.type === "task.status_changed") {
      const { status, summary = null } = event.payload;
      if (!TASK_STATUSES.has(status)) throw new Error(`invalid task status: ${status}`);
      if (summary !== null && typeof summary !== "string") throw new Error("task.status_changed summary must be a string or null");
      this.#assertTaskTransition(task.status, status);
      this.database.prepare(`
        UPDATE tasks SET status = ?, blocked_reason = ?, updated_event_id = ?, updated_at = ?,
          completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
        WHERE task_id = ?
      `).run(status, status === "blocked" ? summary : null, event.id, event.createdAt, status, event.createdAt, event.taskId);
    }
  }
  #assertTaskTransition(current, next) {
    if (current === next) throw new Error(`task is already ${next}`);
    if (!TASK_TRANSITIONS[current]?.has(next)) throw new Error(`invalid task transition: ${current} -> ${next}`);
  }
  #advanceCursor(sourceKey, filePath, byteOffset, prefixHash = null) {
    this.database.prepare(`
      INSERT INTO ingest_cursors(source_key, file_path, byte_offset, prefix_hash, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET file_path=excluded.file_path,
        byte_offset=excluded.byte_offset, prefix_hash=COALESCE(excluded.prefix_hash, ingest_cursors.prefix_hash),
        updated_at=excluded.updated_at
    `).run(sourceKey, filePath, byteOffset, prefixHash, now());
  }
  get(eventId) {
    const row = this.database.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
    return row ? this.#hydrate(row) : null;
  }
  list({ ref = null, taskId = null, agentId = null, type = null, limit = 100 } = {}) {
    validateLimit(limit);
    const conditions = [];
    const values = [];
    if (ref) {
      const row = this.database.prepare("SELECT event_id FROM refs WHERE name = ?").get(ref);
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
    if (taskId) {
      conditions.push("task_id = ?");
      values.push(taskId);
    }
    if (agentId) {
      conditions.push("agent_id = ?");
      values.push(agentId);
    }
    if (type) {
      conditions.push("type = ?");
      values.push(type);
    }
    values.push(limit);
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.database.prepare(`
      SELECT events.* FROM events JOIN event_order ON event_order.event_id = events.id
      ${where} ORDER BY event_order.sequence ASC LIMIT ?
    `).all(...values).map((item) => this.#hydrate(item));
  }
  recentEvents({ limit = 200 } = {}) {
    validateLimit(limit);
    return this.database.prepare(`
      SELECT events.* FROM events JOIN event_order ON event_order.event_id = events.id
      ORDER BY event_order.sequence DESC LIMIT ?
    `).all(limit).map((item) => this.#hydrate(item));
  }
  dashboardSummary() {
    const tasks = Object.fromEntries(this.database.prepare(`
      SELECT status, COUNT(*) AS count FROM tasks GROUP BY status
    `).all().map((row) => [row.status, row.count]));
    const deliveries = Object.fromEntries(this.database.prepare(`
      SELECT status, COUNT(*) AS count FROM deliveries GROUP BY status
    `).all().map((row) => [row.status, row.count]));
    const agents = this.database.prepare("SELECT COUNT(DISTINCT agent_id) AS count FROM events").get().count;
    const events = this.database.prepare("SELECT COUNT(*) AS count FROM events").get().count;
    return { tasks, deliveries, agents, events };
  }
  refs() {
    return this.database.prepare("SELECT name, event_id, updated_at FROM refs ORDER BY name").all();
  }
  verify(eventId) {
    const row = this.database.prepare("SELECT * FROM events WHERE id = ?").get(eventId);
    if (!row) return { valid: false, reason: "event not found" };
    const result = verifyEventRow(row);
    return { valid: result.valid, expected: result.expected, actual: result.actual, ...result.reason ? { reason: result.reason } : {} };
  }
  verifyAll() {
    const issues = [];
    const checked = { events: 0, eventOrder: 0, refs: 0, deliveries: 0, objects: 0, sourceEvents: 0, tasks: 0 };
    const rows = this.database.prepare(`
      SELECT events.*, event_order.sequence AS event_sequence
      FROM events LEFT JOIN event_order ON event_order.event_id = events.id
      ORDER BY event_order.sequence ASC, events.rowid ASC
    `).all();
    const events = /* @__PURE__ */ new Map();
    const orderedEvents = [];
    let previousSequence = 0;
    for (const row of rows) {
      checked.events += 1;
      const result = verifyEventRow(row);
      if (!result.valid) addIssue(issues, {
        kind: "event_hash_mismatch",
        eventId: row.id,
        expected: result.expected,
        actual: result.actual,
        reason: result.reason
      });
      events.set(row.id, result.event);
      if (result.event) orderedEvents.push(result.event);
      checked.eventOrder += 1;
      if (!Number.isInteger(row.event_sequence)) {
        addIssue(issues, { kind: "event_order_missing", eventId: row.id });
      } else if (row.event_sequence <= previousSequence) {
        addIssue(issues, { kind: "event_order_invalid", eventId: row.id, sequence: row.event_sequence });
      } else {
        previousSequence = row.event_sequence;
      }
    }
    for (const row of this.database.prepare(`
      SELECT event_order.event_id FROM event_order
      LEFT JOIN events ON events.id = event_order.event_id
      WHERE events.id IS NULL
    `).all()) {
      addIssue(issues, { kind: "event_order_orphan", eventId: row.event_id });
    }
    const visiting = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new Set();
    const visit = (eventId) => {
      if (visited.has(eventId)) return;
      if (visiting.has(eventId)) {
        addIssue(issues, { kind: "causal_cycle", eventId });
        return;
      }
      const event = events.get(eventId);
      if (!event) return;
      visiting.add(eventId);
      const parents = Array.isArray(event.parents) ? event.parents : null;
      if (!parents) {
        addIssue(issues, { kind: "invalid_parents", eventId });
      } else {
        for (const parent of parents) {
          if (!events.has(parent)) addIssue(issues, { kind: "missing_parent", eventId, parentId: parent });
          else visit(parent);
        }
      }
      if (event.causation_id) {
        if (!events.has(event.causation_id)) addIssue(issues, { kind: "missing_causation", eventId, causationId: event.causation_id });
        else visit(event.causation_id);
      }
      visiting.delete(eventId);
      visited.add(eventId);
    };
    for (const eventId of events.keys()) visit(eventId);
    for (const ref of this.refs()) {
      checked.refs += 1;
      if (ref.event_id !== null && !events.has(ref.event_id)) addIssue(issues, { kind: "ref_missing_event", ref: ref.name, eventId: ref.event_id });
    }
    const deliveries = /* @__PURE__ */ new Map();
    for (const delivery of this.database.prepare("SELECT event_id, recipient_id, status FROM deliveries").all()) {
      checked.deliveries += 1;
      if (!events.has(delivery.event_id)) {
        addIssue(issues, { kind: "delivery_missing_event", eventId: delivery.event_id, recipientId: delivery.recipient_id });
        continue;
      }
      const recipients = deliveries.get(delivery.event_id) ?? [];
      recipients.push(delivery.recipient_id);
      deliveries.set(delivery.event_id, recipients);
      if (!DELIVERY_STATUSES.has(delivery.status)) addIssue(issues, { kind: "invalid_delivery_status", eventId: delivery.event_id, recipientId: delivery.recipient_id });
    }
    for (const [eventId, event] of events) {
      const recipients = deliveries.get(eventId) ?? [];
      if (!event || event.type !== "message.sent") {
        if (recipients.length > 0) addIssue(issues, { kind: "delivery_for_non_message", eventId });
        continue;
      }
      const declared = event.payload?.to;
      if (!Array.isArray(declared) || declared.some((recipient) => typeof recipient !== "string" || !recipient.trim())) {
        addIssue(issues, { kind: "invalid_message_recipients", eventId });
        continue;
      }
      const expected = [...new Set(declared)].sort();
      const actual = [...new Set(recipients)].sort();
      if (expected.length !== actual.length || expected.some((recipient, index) => recipient !== actual[index])) {
        addIssue(issues, { kind: "delivery_recipients_mismatch", eventId, expected, actual });
      }
    }
    const references = /* @__PURE__ */ new Map();
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
        addIssue(issues, { kind: "invalid_object_reference", reference, eventIds: uses.map((use) => use.eventId) });
        continue;
      }
      let content;
      try {
        content = readObject(this.repo, reference);
      } catch {
        addIssue(issues, { kind: "object_missing", reference, eventIds: uses.map((use) => use.eventId) });
        continue;
      }
      const actual = `sha256:${crypto3.createHash("sha256").update(content).digest("hex")}`;
      if (actual !== reference) addIssue(issues, { kind: "object_hash_mismatch", reference, actual, eventIds: uses.map((use) => use.eventId) });
      for (const use of uses) {
        if (Number.isInteger(use.bytes) && use.bytes !== content.length) {
          addIssue(issues, { kind: "object_size_mismatch", reference, eventId: use.eventId, expected: use.bytes, actual: content.length });
        }
      }
    }
    for (const source of this.database.prepare(`
      SELECT source_events.source_key, source_events.source_offset, source_events.event_id, events.id AS existing_event_id
      FROM source_events LEFT JOIN events ON events.id = source_events.event_id
    `).all()) {
      checked.sourceEvents += 1;
      if (!source.existing_event_id) {
        addIssue(issues, { kind: "source_event_missing", sourceKey: source.source_key, sourceOffset: source.source_offset, eventId: source.event_id });
      }
    }
    const expectedTasks = expectedTaskProjection(orderedEvents, (issue) => addIssue(issues, issue));
    const projectedTasks = new Map(this.database.prepare("SELECT * FROM tasks").all().map((row) => [row.task_id, this.#hydrateTask(row)]));
    for (const [taskId, expected] of expectedTasks) {
      checked.tasks += 1;
      const actual = projectedTasks.get(taskId);
      if (!actual) {
        addIssue(issues, { kind: "task_projection_missing", taskId });
        continue;
      }
      const fields = ["title", "description", "priority", "status", "createdBy", "assigneeId", "blockedReason", "createdEventId", "updatedEventId", "createdAt", "updatedAt", "completedAt"];
      const mismatches = fields.filter((field) => actual[field] !== expected[field]);
      if (mismatches.length > 0) addIssue(issues, { kind: "task_projection_mismatch", taskId, fields: mismatches });
    }
    for (const taskId of projectedTasks.keys()) {
      if (!expectedTasks.has(taskId)) checked.tasks += 1;
      if (!expectedTasks.has(taskId)) addIssue(issues, { kind: "task_projection_orphan", taskId });
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
      contentHash: row.content_hash
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
      completedAt: row.completed_at
    };
  }
};

// ../../src/git.mjs
import { execFileSync as execFileSync2 } from "node:child_process";
import path3 from "node:path";
var WORKTREE_PATHS = [".", ":(top,exclude).agentgit", ":(top,exclude).agentgit/**"];
function git(repo, args, options = {}) {
  return execFileSync2("git", ["-C", path3.resolve(repo), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  }).trimEnd();
}
function tryGit(repo, args) {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
}
function statusEntries(status) {
  if (!status) return [];
  const entries = status.split("\0").filter(Boolean);
  const result = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const item = { code, path: entry.slice(3) };
    if (code.includes("R") || code.includes("C")) {
      item.originalPath = entries[index + 1] ?? null;
      index += 1;
    }
    result.push(item);
  }
  return result;
}
function gitState(repo) {
  if (tryGit(repo, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error(`${path3.resolve(repo)} is not a Git worktree`);
  }
  const head = tryGit(repo, ["rev-parse", "HEAD"]);
  const branch = tryGit(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...WORKTREE_PATHS]);
  const stagedDiff = git(repo, ["diff", "--cached", "--binary", "--no-ext-diff", "--", ...WORKTREE_PATHS]);
  const unstagedDiff = git(repo, ["diff", "--binary", "--no-ext-diff", "--", ...WORKTREE_PATHS]);
  return {
    root: git(repo, ["rev-parse", "--show-toplevel"]),
    head,
    branch,
    status: statusEntries(status),
    stagedDiff,
    unstagedDiff
  };
}
function createCheckpoint({ repo, store, agentId, summary, taskId = null, sessionId = null, ref = null, commit = false }) {
  if (typeof summary !== "string" || !summary.trim()) throw new Error("checkpoint summary is required");
  let committed = false;
  if (commit) {
    const beforeState = gitState(repo);
    if (beforeState.status.length > 0) {
      git(repo, ["add", "--all"]);
      const before = beforeState.head;
      try {
        git(repo, ["commit", "-m", summary]);
        committed = true;
      } catch (error) {
        const after = tryGit(repo, ["rev-parse", "HEAD"]);
        if (after === before) throw new Error(`Git commit failed: ${error.stderr?.toString().trim() || error.message}`);
        committed = true;
      }
    }
  }
  const state = gitState(repo);
  const commitPatch = committed && state.head ? git(repo, ["show", "--format=", "--binary", "--no-ext-diff", state.head, "--", ...WORKTREE_PATHS]) : "";
  const patch = commitPatch || [
    state.stagedDiff && `# staged
${state.stagedDiff}`,
    state.unstagedDiff && `# unstaged
${state.unstagedDiff}`
  ].filter(Boolean).join("\n");
  const diff = putObject(repo, patch);
  return store.append({
    agentId,
    type: "git.checkpoint",
    taskId,
    sessionId,
    ref,
    payload: {
      summary,
      git: {
        root: state.root,
        commit: state.head,
        branch: state.branch,
        status: state.status
      },
      diff,
      committed
    }
  });
}

// src/web-route.mjs
import { URL } from "node:url";
var DEFAULT_LIMIT = 50;
var MAX_LIMIT = 200;
function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}
function eventView(event) {
  return {
    id: event.id,
    taskId: event.taskId ?? null,
    sessionId: event.sessionId ?? null,
    agentId: event.agentId,
    type: event.type,
    parents: event.parents ?? [],
    causationId: event.causationId ?? null,
    payload: event.payload ?? {},
    source: event.source ?? null,
    createdAt: event.createdAt,
    contentHash: event.contentHash
  };
}
function dashboardData(store, query = {}) {
  const limit = boundedLimit(query.limit);
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    summary: store.dashboardSummary(),
    tasks: store.listTasks({ limit }),
    events: store.recentEvents({ limit }).map(eventView),
    refs: store.refs()
  };
}
function createAgentGitApiHandler(store) {
  return async (req, res) => {
    if (req.method !== "GET") {
      res.setHeader("allow", "GET");
      json(res, 405, { error: "method_not_allowed" });
      return;
    }
    try {
      const url = new URL(req.url ?? "/agentgit/api", "http://agentgit.local");
      json(res, 200, dashboardData(store, { limit: url.searchParams.get("limit") }));
    } catch (error) {
      json(res, 500, { error: "agentgit_api_failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
}

// src/index.mjs
var name = "agentgit";
var inject = ["tools"];
var Config = Schema.object({
  repo: Schema.string().required(),
  agentId: Schema.string().required(),
  captureSessionEvents: Schema.boolean().default(true),
  captureToolResults: Schema.boolean().default(true)
});
var SESSION_EVENT_TYPES = {
  "user/message": "user.message",
  "assistant/message": "agent.message",
  "assistant/chunk": "agent.chunk",
  "tool/call": "tool.called",
  "tool/result": "tool.completed",
  "turn/start": "turn.started",
  "turn/end": "turn.ended",
  "step/start": "step.started",
  "step/end": "step.ended",
  "compaction/start": "session.compaction.started",
  "compaction/summary": "session.compaction.summary",
  "compaction/end": "session.compaction.ended"
};
function sessionIdOf(session) {
  return session?.id == null ? null : String(session.id);
}
function sessionPayload(event) {
  return {
    data: event?.data ?? null,
    seq: Number.isInteger(event?.seq) ? event.seq : null,
    time: Number.isFinite(event?.time) ? event.time : null,
    ...event?.surfaceOp !== void 0 ? { surfaceOp: event.surfaceOp } : {},
    ...event?.sourceEventSeqs !== void 0 ? { sourceEventSeqs: event.sourceEventSeqs } : {},
    ...event?.ignorable ? { ignorable: true } : {}
  };
}
function sourceForSession(session, event) {
  const sessionId = sessionIdOf(session);
  return {
    adapter: "deepseek-harness",
    sessionId,
    sourceEventId: sessionId && Number.isInteger(event?.seq) ? `${sessionId}:${event.seq}` : null,
    sequence: Number.isInteger(event?.seq) ? event.seq : null,
    eventType: event?.type ?? null,
    eventTime: Number.isFinite(event?.time) ? event.time : null
  };
}
function runtimeValue(value) {
  if (value === void 0) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return value;
  return String(value);
}
function textResult(_args, value) {
  return [{ type: "text", text: value }];
}
function objectTool(ctx, spec) {
  ctx.tools.register(defineTool({
    ...spec,
    output: spec.output ?? { schema: { type: "string" }, render: textResult },
    async execute(args) {
      const value = await spec.execute(args);
      return JSON.stringify(value, null, 2);
    }
  }));
}
function arrayTool(ctx, spec) {
  ctx.tools.register(defineTool({
    ...spec,
    output: spec.output ?? { schema: { type: "string" }, render: textResult },
    async execute(args) {
      const value = await spec.execute(args);
      return JSON.stringify(value, null, 2);
    }
  }));
}
function stringParameter(required = false, description) {
  return { type: "string", ...required ? { required: true } : {}, ...description ? { description } : {} };
}
function registerTools(ctx, store, config) {
  arrayTool(ctx, {
    name: "agentgit_read_inbox",
    description: "Read durable messages addressed to the configured AgentGit agent. Pending messages become delivered.",
    parameters: {
      status: stringParameter(false, "Optional delivery status: pending, delivered, or acknowledged."),
      limit: { type: "number", description: "Maximum number of messages to return." }
    },
    async execute(args) {
      return store.receiveInbox({
        agentId: config.agentId,
        status: args?.status ?? null,
        limit: args?.limit ?? 100
      });
    }
  });
  objectTool(ctx, {
    name: "agentgit_send_message",
    description: "Send a durable message to one or more AgentGit agents.",
    parameters: {
      to: { type: "array", required: true, description: "Recipient agent IDs.", items: { type: "string" } },
      text: stringParameter(true, "Message body."),
      subject: stringParameter(false, "Optional subject."),
      taskId: stringParameter(false, "Optional related task ID."),
      causationEventId: stringParameter(false, "Event ID this message responds to."),
      references: { type: "array", items: { type: "string" }, description: "Event or checkpoint references." }
    },
    async execute(args) {
      return store.sendMessage({
        from: config.agentId,
        to: args.to,
        text: args.text,
        subject: args.subject ?? null,
        taskId: args.taskId ?? null,
        causationId: args.causationEventId ?? null,
        references: args.references ?? [],
        ref: `agent/${config.agentId}`
      });
    }
  });
  objectTool(ctx, {
    name: "agentgit_acknowledge_message",
    description: "Acknowledge that the configured AgentGit agent acted on a message.",
    parameters: { eventId: stringParameter(true, "Message event ID.") },
    async execute(args) {
      return store.acknowledge(args.eventId, config.agentId);
    }
  });
  objectTool(ctx, {
    name: "agentgit_create_task",
    description: "Create a durable AgentGit task.",
    parameters: {
      title: stringParameter(true, "Task title."),
      description: stringParameter(false, "Task description."),
      priority: stringParameter(false, "low, normal, high, or urgent.")
    },
    async execute(args) {
      return store.createTask({
        createdBy: config.agentId,
        title: args.title,
        description: args.description ?? "",
        priority: args.priority ?? "normal"
      });
    }
  });
  objectTool(ctx, {
    name: "agentgit_update_task",
    description: "Assign a task and/or move it through its lifecycle.",
    parameters: {
      taskId: stringParameter(true, "Task ID."),
      assigneeId: stringParameter(false, "Agent to assign."),
      note: stringParameter(false, "Assignment note."),
      status: stringParameter(false, "assigned, in_progress, blocked, completed, or cancelled."),
      summary: stringParameter(false, "Status transition summary.")
    },
    async execute(args) {
      if (!args.assigneeId && !args.status) throw new Error("agentgit_update_task requires assigneeId or status");
      return store.updateTask({
        taskId: args.taskId,
        updatedBy: config.agentId,
        assigneeId: args.assigneeId ?? null,
        note: args.note ?? null,
        status: args.status ?? null,
        summary: args.summary ?? null
      });
    }
  });
  arrayTool(ctx, {
    name: "agentgit_task_history",
    description: "Read the immutable event history for a task.",
    parameters: {
      taskId: stringParameter(true, "Task ID."),
      limit: { type: "number" }
    },
    async execute(args) {
      return store.list({ taskId: args.taskId, limit: args.limit ?? 100 });
    }
  });
  arrayTool(ctx, {
    name: "agentgit_list_tasks",
    description: "List task state reconstructed from immutable task events.",
    parameters: {
      assigneeId: stringParameter(false, "Optional agent ID to filter by assignee."),
      status: stringParameter(false, "Optional task status."),
      limit: { type: "number" }
    },
    async execute(args) {
      return store.listTasks({ assigneeId: args?.assigneeId ?? null, status: args?.status ?? null, limit: args?.limit ?? 100 });
    }
  });
  objectTool(ctx, {
    name: "agentgit_create_checkpoint",
    description: "Record the current Git state and a content-addressed diff as an AgentGit checkpoint.",
    parameters: {
      summary: stringParameter(true, "Concise description of the work."),
      taskId: stringParameter(false, "Optional related task ID."),
      commit: { type: "boolean", description: "Commit current worktree before recording." }
    },
    async execute(args) {
      return createCheckpoint({
        repo: config.repo,
        store,
        agentId: config.agentId,
        summary: args.summary,
        taskId: args.taskId ?? null,
        ref: `agent/${config.agentId}`,
        commit: args.commit === true
      });
    }
  });
  objectTool(ctx, {
    name: "agentgit_verify_history",
    description: "Audit event hashes, causal parents, deliveries, objects, refs, and task projections.",
    parameters: {},
    async execute() {
      return store.verifyAll();
    }
  });
  objectTool(ctx, {
    name: "agentgit_rebuild_task_projection",
    description: "Rebuild the mutable task projection from immutable task events without changing event history.",
    parameters: {},
    async execute() {
      return { events: store.rebuildTaskProjection() };
    }
  });
}
function apply(ctx, config) {
  initRepository(config.repo);
  const store = new EventStore(config.repo);
  ctx.effect(() => () => store.close());
  const recordSessionEvent = (session, event) => {
    if (!config.captureSessionEvents || !event?.type) return;
    const sessionId = sessionIdOf(session);
    const sourceKey = sessionId ? `harness:${sessionId}` : null;
    const sourceOffset = Number.isInteger(event.seq) ? event.seq : null;
    store.append({
      agentId: config.agentId,
      type: SESSION_EVENT_TYPES[event.type] ?? `harness.${event.type.replaceAll("/", ".")}`,
      payload: sessionPayload(event),
      sessionId,
      ref: sessionId ? `session/${sessionId}` : `agent/${config.agentId}`,
      source: sourceForSession(session, event),
      ...sourceKey && sourceOffset !== null ? {
        ingest: {
          sourceKey,
          sourceOffset,
          filePath: `harness://${sessionId}`,
          nextOffset: sourceOffset + 1
        }
      } : {}
    });
  };
  if (config.captureSessionEvents) {
    ctx.on("session/event", recordSessionEvent);
  }
  if (config.captureToolResults) {
    ctx.on("tools/result", (exec, result) => {
      store.append({
        agentId: config.agentId,
        type: "tool.runtime_result",
        sessionId: exec?.sessionId == null ? null : String(exec.sessionId),
        ref: `agent/${config.agentId}`,
        payload: {
          callId: runtimeValue(exec?.callId ?? null),
          name: runtimeValue(exec?.name ?? null),
          arguments: runtimeValue(exec?.arguments ?? null),
          content: runtimeValue(result?.content ?? null),
          meta: runtimeValue(result?.meta ?? null)
        },
        source: { adapter: "deepseek-harness", event: "tools/result" }
      });
    });
  }
  if (config.captureSessionEvents) {
    ctx.on("session/disposed", (session) => {
      store.append({
        agentId: config.agentId,
        type: "session.disposed",
        sessionId: sessionIdOf(session),
        ref: `agent/${config.agentId}`,
        payload: { sessionId: sessionIdOf(session) },
        source: { adapter: "deepseek-harness", event: "session/disposed" }
      });
    });
  }
  registerTools(ctx, store, config);
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (webCtx) => {
      const dispose = webCtx.webServer.register({
        kind: "exact",
        path: "/agentgit/api",
        handler: createAgentGitApiHandler(store)
      });
      return () => dispose();
    });
  } else if (ctx.webServer?.register) {
    ctx.effect(() => ctx.webServer.register({
      kind: "exact",
      path: "/agentgit/api",
      handler: createAgentGitApiHandler(store)
    }));
  }
}
export {
  Config,
  apply,
  inject,
  name
};
