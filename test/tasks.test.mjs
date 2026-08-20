import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepository, EventStore } from '../src/store.mjs';

function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-task-')); }

test('projects immutable task events into a current task state', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const created = store.createTask({ createdBy: 'planner', title: 'Implement login', description: 'Use sessions', priority: 'high' });
  assert.equal(created.task.status, 'open');
  assert.equal(created.task.priority, 'high');
  const assigned = store.assignTask({ taskId: created.task.id, assignedBy: 'planner', assigneeId: 'coder' });
  assert.equal(assigned.task.status, 'assigned');
  assert.equal(assigned.task.assigneeId, 'coder');
  const started = store.updateTaskStatus({ taskId: created.task.id, updatedBy: 'coder', status: 'in_progress' });
  assert.equal(started.task.status, 'in_progress');
  const completed = store.updateTaskStatus({ taskId: created.task.id, updatedBy: 'coder', status: 'completed', summary: 'Tests pass' });
  assert.equal(completed.task.status, 'completed');
  assert.ok(completed.task.completedAt);
  assert.deepEqual(store.listTasks({ assigneeId: 'coder' }).map((task) => task.id), [created.task.id]);
  assert.deepEqual(store.list({ ref: `task/${created.task.id}` }).map((event) => event.type), [
    'task.created', 'task.assigned', 'task.status_changed', 'task.status_changed',
  ]);
  store.close();
});

test('rejects invalid transitions and terminal-task updates without writing events', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const { task } = store.createTask({ createdBy: 'planner', title: 'Review release' });
  assert.throws(() => store.updateTaskStatus({ taskId: task.id, updatedBy: 'planner', status: 'completed' }), /invalid task transition/);
  store.updateTaskStatus({ taskId: task.id, updatedBy: 'planner', status: 'cancelled' });
  assert.throws(() => store.assignTask({ taskId: task.id, assignedBy: 'planner', assigneeId: 'reviewer' }), /cannot assign a cancelled task/);
  assert.equal(store.list({ ref: `task/${task.id}` }).length, 2);
  store.close();
});

test('rebuilds task projection from its immutable event history', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const { task } = store.createTask({ createdBy: 'planner', title: 'Document API' });
  store.assignTask({ taskId: task.id, assignedBy: 'planner', assigneeId: 'writer' });
  store.updateTaskStatus({ taskId: task.id, updatedBy: 'writer', status: 'in_progress' });
  store.database.prepare('DELETE FROM tasks').run();
  assert.equal(store.listTasks().length, 0);
  assert.equal(store.rebuildTaskProjection(), 3);
  assert.equal(store.getTask(task.id).status, 'in_progress');
  assert.equal(store.getTask(task.id).assigneeId, 'writer');
  store.close();
});
