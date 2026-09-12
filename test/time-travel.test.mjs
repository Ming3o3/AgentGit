import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore } from '../src/store.mjs';

function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-state-at-')); }

test('replays event-derived state at an event or local sequence', () => {
  const store = new EventStore(tempRepo());
  const note = store.append({ agentId: 'planner', type: 'plan.recorded', payload: { ready: true } });
  const created = store.createTask({ createdBy: 'planner', title: 'Historical state' });
  const assigned = store.assignTask({ taskId: created.task.id, assignedBy: 'planner', assigneeId: 'coder' });
  store.updateTaskStatus({ taskId: created.task.id, updatedBy: 'coder', status: 'in_progress' });

  const beforeTask = store.stateAt({ eventId: note.id, taskId: created.task.id });
  assert.equal(beforeTask.asOf.sequence, 1);
  assert.equal(beforeTask.task, null);
  assert.deepEqual(beforeTask.summary.eventTypes, { 'plan.recorded': 1 });

  const atCreation = store.stateAt({ eventId: created.event.id, taskId: created.task.id });
  assert.equal(atCreation.task.status, 'open');
  assert.equal(atCreation.task.assigneeId, null);
  assert.deepEqual(atCreation.summary.tasks, { open: 1 });

  const atAssignment = store.stateAt({ sequence: 3 });
  assert.equal(atAssignment.asOf.eventId, assigned.event.id);
  assert.equal(atAssignment.tasks[0].status, 'assigned');
  assert.equal(atAssignment.tasks[0].assigneeId, 'coder');
  assert.equal(atAssignment.summary.events, 3);
  assert.equal(atAssignment.summary.agents, 1);

  assert.equal(store.getTask(created.task.id).status, 'in_progress');
  store.close();
});

test('rejects ambiguous and unknown historical boundaries', () => {
  const store = new EventStore(tempRepo());
  const event = store.append({ agentId: 'planner', type: 'plan.recorded', payload: {} });
  assert.throws(() => store.stateAt(), /exactly one/);
  assert.throws(() => store.stateAt({ eventId: event.id, sequence: 1 }), /exactly one/);
  assert.throws(() => store.stateAt({ sequence: 0 }), /positive integer/);
  assert.throws(() => store.stateAt({ sequence: 2 }), /sequence does not exist/);
  assert.throws(() => store.stateAt({ eventId: 'evt_missing' }), /event does not exist/);
  store.close();
});
