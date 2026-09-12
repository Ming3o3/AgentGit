import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { initRepository, EventStore } from '../src/store.mjs';
import { startDashboard } from '../src/dashboard-server.mjs';

function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-dashboard-')); }

test('serves project tasks, events, refs, and metrics through the local dashboard API', async () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const created = store.createTask({ createdBy: 'planner', title: 'Render dashboard' });
  const { task } = created;
  const assigned = store.assignTask({ taskId: task.id, assignedBy: 'planner', assigneeId: 'coder' });
  const message = store.sendMessage({
    from: 'planner', to: 'coder', text: 'Build the dashboard', taskId: task.id,
    causationId: assigned.event.id,
  });
  store.append({ agentId: 'coder', type: 'work.started', payload: {}, parents: [assigned.event.id] });
  store.close();
  const dashboard = await startDashboard({ repo, port: 0 });
  try {
    const overview = await fetch(`${dashboard.url}/api/overview`).then((response) => response.json());
    assert.equal(overview.repo, repo);
    assert.equal(overview.summary.events, 4);
    assert.equal(overview.summary.deliveries.pending, 1);
    assert.equal(overview.metrics.events.total, 4);
    assert.equal(overview.health.status, 'healthy');
    assert.equal(overview.tasks[0].assigneeId, 'coder');
    assert.equal(overview.events.some((event) => event.type === 'message.sent'), true);
    assert.equal(overview.refs.length, 1);
    const context = await fetch(`${dashboard.url}/api/events/${assigned.event.id}/context`).then((response) => response.json());
    assert.equal(context.event.id, assigned.event.id);
    assert.equal(context.parents[0].id, created.event.id);
    assert.equal(context.children[0].type, 'work.started');
    assert.equal(context.effects[0].id, message.id);
    assert.equal((await fetch(`${dashboard.url}/api/events/evt_missing/context`)).status, 404);
    const page = await fetch(dashboard.url).then((response) => response.text());
    assert.match(page, /AgentGit/);
    assert.match(page, /event-search/);
  } finally {
    await new Promise((resolve) => dashboard.server.close(resolve));
  }
});

test('contains unusual dashboard URLs without taking down the server', async () => {
  const repo = tempRepo();
  const dashboard = await startDashboard({ repo, port: 0 });
  const address = dashboard.server.address();
  const request = () => new Promise((resolve, reject) => {
    const client = http.request({ hostname: '127.0.0.1', port: address.port, path: '/%zz' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    client.on('error', reject);
    client.end();
  });
  try {
    assert.equal((await request()).status, 404);
    assert.equal((await fetch(`${dashboard.url}/api/overview`)).status, 200);
  } finally {
    await new Promise((resolve) => dashboard.server.close(resolve));
  }
});

test('cleans up the store when dashboard binding fails', async () => {
  const repo = tempRepo();
  const first = await startDashboard({ repo, port: 0 });
  const address = first.server.address();
  try {
    await assert.rejects(() => startDashboard({ repo, port: address.port }), /EADDRINUSE/);
  } finally {
    await new Promise((resolve) => first.server.close(resolve));
  }
  const recovered = await startDashboard({ repo, port: address.port });
  await new Promise((resolve) => recovered.server.close(resolve));
});
