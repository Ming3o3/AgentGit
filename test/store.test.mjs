import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { initRepository, EventStore } from '../src/store.mjs';
import { canonicalJson, sha256 } from '../src/canonical-json.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-'));
}

function appendFromProcess({ worker, repo, agentId }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, repo, agentId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`worker failed (${code}): ${stderr}`));
    });
  });
}

test('initializes a repository and appends a hash-addressed event', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const event = store.append({
    agentId: 'planner',
    type: 'task.created',
    payload: { title: 'Implement login' },
    taskId: 'task-1',
    ref: 'task/task-1',
  });
  assert.match(event.id, /^evt_/);
  assert.equal(event.parents.length, 0);
  assert.equal(event.payload.title, 'Implement login');
  assert.equal(store.get(event.id).contentHash, event.contentHash);
  assert.equal(store.verify(event.id).valid, true);
  assert.deepEqual(store.refs(), [{ name: 'task/task-1', event_id: event.id, updated_at: store.refs()[0].updated_at }]);
  store.close();
});

test('upgrades a schema v1 database without losing existing events', () => {
  const repo = tempRepo();
  const directory = path.join(repo, '.agentgit');
  fs.mkdirSync(directory, { recursive: true });
  const database = new Database(path.join(directory, 'events.db'));
  database.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events (
      id TEXT PRIMARY KEY, task_id TEXT, session_id TEXT, agent_id TEXT NOT NULL,
      type TEXT NOT NULL, parents_json TEXT NOT NULL, causation_id TEXT,
      payload_json TEXT NOT NULL, source_json TEXT, created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE refs (
      name TEXT PRIMARY KEY, event_id TEXT, updated_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    INSERT INTO metadata(key, value) VALUES ('schema_version', '1');
  `);
  const existing = {
    id: 'evt_legacy',
    task_id: null,
    session_id: 'legacy-session',
    agent_id: 'legacy-agent',
    type: 'note.recorded',
    parents: [],
    causation_id: null,
    payload: { text: 'kept' },
    source: null,
    created_at: '2026-08-01T00:00:00.000Z',
  };
  database.prepare(`
    INSERT INTO events(id, task_id, session_id, agent_id, type, parents_json, causation_id,
      payload_json, source_json, created_at, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(existing.id, existing.task_id, existing.session_id, existing.agent_id, existing.type,
    canonicalJson(existing.parents), existing.causation_id, canonicalJson(existing.payload),
    null, existing.created_at, sha256(existing));
  database.close();
  initRepository(repo);
  const store = new EventStore(repo);
  const task = store.createTask({ createdBy: 'planner', title: 'Post-upgrade task' });
  assert.equal(store.get('evt_legacy').payload.text, 'kept');
  assert.equal(store.list({ limit: 10 }).length, 2);
  assert.equal(store.getTask(task.task.id).status, 'open');
  assert.equal(store.database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '3');
  assert.equal(store.verifyAll().valid, true);
  store.close();
});

test('rejects a database created by a newer schema version', () => {
  const repo = tempRepo();
  const directory = path.join(repo, '.agentgit');
  fs.mkdirSync(directory, { recursive: true });
  const database = new Database(path.join(directory, 'events.db'));
  database.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('schema_version', '999');
  database.close();
  assert.throws(() => initRepository(repo), /unsupported AgentGit schema version: 999/);
  assert.throws(() => new EventStore(repo), /unsupported AgentGit schema version: 999/);
});

test('rejects malformed schema metadata before running migrations', () => {
  const repo = tempRepo();
  const directory = path.join(repo, '.agentgit');
  fs.mkdirSync(directory, { recursive: true });
  const database = new Database(path.join(directory, 'events.db'));
  database.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('schema_version', 'not-a-version');
  database.close();
  assert.throws(() => initRepository(repo), /unsupported AgentGit schema version: not-a-version/);
  assert.throws(() => new EventStore(repo), /unsupported AgentGit schema version: not-a-version/);
  const reopened = new Database(path.join(directory, 'events.db'));
  assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get(), undefined);
  reopened.close();
});

test('enforces event immutability inside SQLite', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const event = store.append({ agentId: 'planner', type: 'task.created', payload: {} });
  assert.throws(
    () => store.database.prepare('UPDATE events SET type = ? WHERE id = ?').run('changed', event.id),
    /events are immutable/,
  );
  assert.throws(
    () => store.database.prepare('DELETE FROM events WHERE id = ?').run(event.id),
    /events are immutable/,
  );
  assert.equal(store.get(event.id).type, 'task.created');
  store.close();
});

test('does not treat ordinary hash fields as AgentGit object references', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  store.append({ agentId: 'coder', type: 'build.completed', payload: { hash: 'git-commit-sha' } });
  assert.deepEqual(store.verifyAll().issues, []);
  store.close();
});

test('rejects invalid query limits at the storage boundary', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  for (const query of [
    () => store.list({ limit: 0 }),
    () => store.list({ limit: 1.5 }),
    () => store.list({ limit: Number.POSITIVE_INFINITY }),
    () => store.recentEvents({ limit: 10001 }),
    () => store.listTasks({ limit: -1 }),
    () => store.inbox({ agentId: 'coder', limit: true }),
  ]) {
    assert.throws(query, /limit must be an integer between 1 and 10000/);
  }
  store.close();
});

test('updates assignment and status atomically', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const created = store.createTask({ createdBy: 'planner', title: 'Atomic task' });
  const updated = store.updateTask({ taskId: created.task.id, updatedBy: 'planner', assigneeId: 'coder', status: 'in_progress' });
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.assigneeId, 'coder');
  assert.deepEqual(store.list({ taskId: created.task.id }).map((event) => event.type), ['task.created', 'task.assigned', 'task.status_changed']);
  assert.equal(store.verifyAll().valid, true);
  store.close();
});

test('rolls back assignment when the combined status update is invalid', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const created = store.createTask({ createdBy: 'planner', title: 'Atomic failure' });
  assert.throws(
    () => store.updateTask({ taskId: created.task.id, updatedBy: 'planner', assigneeId: 'coder', status: 'completed' }),
    /invalid task transition: assigned -> completed/,
  );
  assert.equal(store.getTask(created.task.id).status, 'open');
  assert.equal(store.getTask(created.task.id).assigneeId, null);
  assert.deepEqual(store.list({ taskId: created.task.id }).map((event) => event.type), ['task.created']);
  assert.equal(store.verifyAll().valid, true);
  store.close();
});

test('uses the ref head as the next parent and returns branch history', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const first = store.append({ agentId: 'planner', type: 'task.created', payload: {}, ref: 'main' });
  const second = store.append({ agentId: 'coder', type: 'message.sent', payload: { text: 'started' }, ref: 'main' });
  assert.deepEqual(second.parents, [first.id]);
  assert.deepEqual(store.list({ ref: 'main' }).map((event) => event.id), [first.id, second.id]);
  store.close();
});

test('keeps a stable insertion order when events share a timestamp', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const createdAt = '2026-08-20T12:00:00.000Z';
  const first = store.append({ agentId: 'planner', type: 'task.created', payload: {}, createdAt });
  const second = store.append({ agentId: 'coder', type: 'tool.called', payload: {}, createdAt });
  const third = store.append({ agentId: 'coder', type: 'tool.completed', payload: {}, createdAt });
  assert.deepEqual(store.list().map((event) => event.id), [first.id, second.id, third.id]);
  assert.deepEqual(store.recentEvents().map((event) => event.id), [third.id, second.id, first.id]);
  store.close();
});

test('serializes concurrent appends to one ref into a causal chain', async () => {
  const repo = tempRepo();
  initRepository(repo);
  const worker = path.join(repo, 'append-worker.mjs');
  const storeUrl = pathToFileURL(path.resolve('src/store.mjs')).href;
  fs.writeFileSync(worker, `import { EventStore } from ${JSON.stringify(storeUrl)};
const store = new EventStore(process.argv[2]);
const event = store.append({ agentId: process.argv[3], type: 'note.recorded', payload: {}, ref: 'main' });
store.close();
process.stdout.write(JSON.stringify(event));
`);
  const events = await Promise.all(Array.from({ length: 8 }, (_, index) => appendFromProcess({
    worker, repo, agentId: `agent-${index}`,
  })));
  const store = new EventStore(repo);
  const history = store.list({ ref: 'main', limit: 20 });
  assert.equal(history.length, events.length);
  assert.deepEqual(history[0].parents, []);
  for (let index = 1; index < history.length; index += 1) {
    assert.deepEqual(history[index].parents, [history[index - 1].id]);
  }
  store.close();
});

test('rebuilds the event order projection without modifying historical events', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const first = store.append({ agentId: 'planner', type: 'task.created', payload: {} });
  const second = store.append({ agentId: 'coder', type: 'tool.completed', payload: {} });
  store.database.exec('DROP TABLE event_order');
  store.close();

  const reopened = new EventStore(repo);
  assert.equal(reopened.verify(first.id).valid, true);
  assert.equal(reopened.verify(second.id).valid, true);
  assert.deepEqual(reopened.list().map((event) => event.id), [first.id, second.id]);
  reopened.close();
});

test('audits hashes, links, objects, and rebuildable projections', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const { task } = store.createTask({ createdBy: 'planner', title: 'Audit state' });
  store.assignTask({ taskId: task.id, assignedBy: 'planner', assigneeId: 'coder' });
  const output = store.append({ agentId: 'coder', type: 'tool.completed', payload: { output: 'x'.repeat(9000) }, taskId: task.id });
  assert.deepEqual(store.verifyAll().issues, []);

  const objectRef = output.payload.output.objectRef;
  const objectPath = path.join(repo, '.agentgit', 'objects', objectRef.slice(7, 9), objectRef.slice(9));
  fs.unlinkSync(objectPath);
  store.database.prepare('UPDATE tasks SET title = ? WHERE task_id = ?').run('Corrupt title', task.id);
  const audit = store.verifyAll();
  assert.equal(audit.valid, false);
  assert.ok(audit.issues.some((issue) => issue.kind === 'object_missing' && issue.reference === objectRef));
  assert.ok(audit.issues.some((issue) => issue.kind === 'task_projection_mismatch' && issue.taskId === task.id));
  store.close();
});

test('rejects a missing parent and never writes a partial event', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  assert.throws(() => store.append({ agentId: 'coder', type: 'message.sent', payload: {}, parents: ['evt_missing'] }), /parent event does not exist/);
  assert.equal(store.list().length, 0);
  store.close();
});

test('supports filtered event queries', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  store.append({ agentId: 'planner', type: 'task.created', payload: { title: 'Plan API' }, taskId: 'task-1' });
  store.append({ agentId: 'coder', type: 'tool.completed', payload: {}, taskId: 'task-1' });
  store.append({ agentId: 'reviewer', type: 'review.requested', payload: {}, taskId: 'task-2' });
  assert.equal(store.list({ taskId: 'task-1' }).length, 2);
  assert.equal(store.list({ agentId: 'reviewer' })[0].type, 'review.requested');
  store.close();
});
