import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepository, EventStore } from '../src/store.mjs';
import { startDashboard } from '../src/dashboard-server.mjs';

function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-dashboard-')); }

test('serves project tasks, events, refs, and metrics through the local dashboard API', async () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const { task } = store.createTask({ createdBy: 'planner', title: 'Render dashboard' });
  store.assignTask({ taskId: task.id, assignedBy: 'planner', assigneeId: 'coder' });
  store.sendMessage({ from: 'planner', to: 'coder', text: 'Build the dashboard', taskId: task.id });
  store.close();
  const dashboard = await startDashboard({ repo, port: 0 });
  try {
    const overview = await fetch(`${dashboard.url}/api/overview`).then((response) => response.json());
    assert.equal(overview.repo, repo);
    assert.equal(overview.summary.events, 3);
    assert.equal(overview.summary.deliveries.pending, 1);
    assert.equal(overview.tasks[0].assigneeId, 'coder');
    assert.equal(overview.events[0].type, 'message.sent');
    assert.equal(overview.refs.length, 1);
    const page = await fetch(dashboard.url).then((response) => response.text());
    assert.match(page, /AgentGit/);
  } finally {
    await new Promise((resolve) => dashboard.server.close(resolve));
  }
});
