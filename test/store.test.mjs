import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepository, EventStore } from '../src/store.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-'));
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
