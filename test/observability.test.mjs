import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../src/store.mjs';

function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-observability-')); }

test('reports workflow, ingest, throughput, and storage metrics', () => {
  const store = new EventStore(tempRepo());
  const { task } = store.createTask({ createdBy: 'planner', title: 'Measure workflows' });
  store.assignTask({ taskId: task.id, assignedBy: 'planner', assigneeId: 'coder' });
  store.updateTaskStatus({ taskId: task.id, updatedBy: 'coder', status: 'in_progress' });
  store.updateTaskStatus({ taskId: task.id, updatedBy: 'coder', status: 'completed' });
  const message = store.sendMessage({ from: 'planner', to: ['coder'], text: 'x'.repeat(9000) });
  store.acknowledge(message.id, 'coder');
  const rollout = path.join(tempRepo(), 'events.jsonl');
  fs.writeFileSync(rollout, '{"value":1}\n');
  store.importJsonl({
    filePath: rollout,
    agentId: 'coder',
    sourceKey: 'metrics:test',
    adapter: (raw) => ({ type: 'source.observed', payload: raw }),
  });

  const metrics = store.metrics({ windowMinutes: 60 });
  assert.equal(metrics.events.total, 6);
  assert.equal(metrics.events.inWindow, 6);
  assert.equal(metrics.events.byType['task.created'], 1);
  assert.equal(metrics.messages.byStatus.acknowledged, 1);
  assert.equal(metrics.messages.deliveryLatency.samples, 1);
  assert.equal(metrics.messages.acknowledgementLatency.samples, 1);
  assert.equal(metrics.tasks.byStatus.completed, 1);
  assert.equal(metrics.tasks.completionDuration.samples, 1);
  assert.equal(metrics.ingest.sources, 1);
  assert.ok(metrics.ingest.lastCursorUpdate);
  assert.equal(metrics.storage.objects, 1);
  assert.ok(metrics.storage.objectBytes >= 9000);
  assert.ok(metrics.storage.databaseBytes > 0);
  store.close();
});

test('turns local integrity and workflow conditions into actionable health alerts', () => {
  const store = new EventStore(tempRepo());
  const healthy = store.health();
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.integrity.valid, true);
  assert.deepEqual(healthy.alerts, []);

  const { task } = store.createTask({ createdBy: 'planner', title: 'Blocked work' });
  store.updateTaskStatus({ taskId: task.id, updatedBy: 'planner', status: 'blocked', summary: 'Needs input' });
  store.sendMessage({ from: 'planner', to: ['coder'], text: 'Please respond' });
  store.append({ agentId: 'coder', type: 'capture.failed', payload: { source: 'test' } });
  const report = store.health({ pendingAgeMinutes: 0, verify: false });
  assert.equal(report.status, 'unhealthy');
  assert.equal(report.integrity, null);
  assert.deepEqual(report.alerts.map((alert) => alert.code), [
    'capture_failures', 'blocked_tasks', 'stale_pending_messages',
  ]);
  store.close();
});

test('validates metric and alert windows', () => {
  const store = new EventStore(tempRepo());
  assert.throws(() => store.metrics({ windowMinutes: 0 }), /windowMinutes/);
  assert.throws(() => store.metrics({ measuredAt: 'not-a-date' }), /measuredAt/);
  assert.throws(() => store.health({ pendingAgeMinutes: -1 }), /pendingAgeMinutes/);
  assert.throws(() => store.health({ verify: 'yes' }), /verify/);
  store.close();
});
