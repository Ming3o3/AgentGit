import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepository, EventStore } from '../src/store.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-message-'));
}

test('sends one immutable event to multiple recipient inboxes', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const message = store.sendMessage({ from: 'planner', to: ['coder', 'reviewer', 'coder'], subject: 'Work', text: 'Please implement the API', taskId: 'task-1' });
  assert.equal(message.type, 'message.sent');
  assert.deepEqual(message.payload.to, ['coder', 'reviewer']);
  assert.equal(store.inbox({ agentId: 'coder' })[0].delivery.status, 'pending');
  assert.equal(store.inbox({ agentId: 'reviewer' })[0].payload.text, 'Please implement the API');
  store.close();
});

test('links a reply message to the event that caused it', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const request = store.sendMessage({ from: 'planner', to: 'coder', text: 'Start' });
  const reply = store.sendMessage({ from: 'coder', to: 'planner', text: 'Started', causationId: request.id });
  assert.equal(reply.causationId, request.id);
  assert.equal(store.get(reply.id).causationId, request.id);
  assert.throws(() => store.sendMessage({ from: 'coder', to: 'planner', text: 'Broken', causationId: 'evt_missing' }), /causation event does not exist/);
  store.close();
});

test('acknowledgement is idempotent and only changes delivery state', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const message = store.sendMessage({ from: 'planner', to: 'coder', text: 'Start' });
  const delivered = store.markDelivered(message.id, 'coder');
  assert.equal(delivered.status, 'delivered');
  const acknowledged = store.acknowledge(message.id, 'coder');
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(store.acknowledge(message.id, 'coder').status, 'acknowledged');
  assert.equal(store.get(message.id).payload.text, 'Start');
  assert.equal(store.inbox({ agentId: 'coder', status: 'pending' }).length, 0);
  assert.equal(store.inbox({ agentId: 'coder', status: 'acknowledged' }).length, 1);
  store.close();
});

test('receiving an inbox message records delivery without acknowledging work', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const message = store.sendMessage({ from: 'planner', to: 'coder', text: 'Start' });
  const received = store.receiveInbox({ agentId: 'coder' });
  assert.equal(received.length, 1);
  assert.equal(received[0].id, message.id);
  assert.equal(received[0].delivery.status, 'delivered');
  assert.ok(received[0].delivery.deliveredAt);
  assert.equal(store.delivery(message.id, 'coder').status, 'delivered');
  assert.equal(store.inbox({ agentId: 'coder', status: 'pending' }).length, 0);
  assert.equal(store.inbox({ agentId: 'coder', status: 'delivered' }).length, 1);
  store.close();
});

test('rejects acknowledgement for a recipient that was not addressed', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const message = store.sendMessage({ from: 'planner', to: 'coder', text: 'Start' });
  assert.throws(() => store.acknowledge(message.id, 'reviewer'), /delivery does not exist/);
  store.close();
});

test('audits delivery state timestamps and chronology', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const pending = store.sendMessage({ from: 'planner', to: 'coder', text: 'Pending' });
  const acknowledged = store.sendMessage({ from: 'planner', to: 'reviewer', text: 'Acknowledged' });
  store.acknowledge(acknowledged.id, 'reviewer');
  assert.equal(store.verifyAll().valid, true);

  store.database.prepare(`
    UPDATE deliveries SET delivered_at = 'not-a-timestamp'
    WHERE event_id = ? AND recipient_id = 'coder'
  `).run(pending.id);
  store.database.prepare(`
    UPDATE deliveries SET created_at = '2099-01-01T00:00:00.000Z',
      delivered_at = '2099-01-02T00:00:00.000Z', acknowledged_at = '2099-01-01T00:00:00.000Z'
    WHERE event_id = ? AND recipient_id = 'reviewer'
  `).run(acknowledged.id);

  const audit = store.verifyAll();
  assert.equal(audit.valid, false);
  assert.ok(audit.issues.some((issue) => issue.kind === 'invalid_delivery_delivered_at' && issue.eventId === pending.id));
  assert.ok(audit.issues.some((issue) => issue.kind === 'invalid_delivery_state_timestamps' && issue.eventId === pending.id));
  assert.ok(audit.issues.some((issue) => issue.kind === 'invalid_delivery_created_at' && issue.eventId === acknowledged.id));
  assert.ok(audit.issues.some((issue) => issue.kind === 'invalid_delivery_timestamp_order' && issue.eventId === acknowledged.id));
  store.close();
});
