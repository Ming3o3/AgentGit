import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardData, createAgentGitApiHandler, MAX_LIMIT } from '../src/web-route.mjs';

function response() {
  return {
    headers: {},
    status: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(value) { this.body = value; },
  };
}

function storeFixture() {
  return {
    dashboardSummary: () => ({ tasks: { open: 1 }, deliveries: { pending: 2 }, agents: 1, events: 3 }),
    listTasks: ({ limit }) => [{ id: 'task-1', title: 'Demo', status: 'open', limit }],
    recentEvents: ({ limit }) => [{ id: 'evt-1', agentId: 'coder', type: 'user.message', parents: [], payload: { text: 'hi' }, createdAt: '2026-01-01T00:00:00.000Z', contentHash: 'sha256:test' }].slice(0, limit),
    refs: () => [{ name: 'agent/coder', event_id: 'evt-1', updated_at: '2026-01-01T00:00:00.000Z' }],
  };
}

test('dashboard projection contains only the panel read model and bounds limits', () => {
  const data = dashboardData(storeFixture(), { limit: '99999' });
  assert.deepEqual(Object.keys(data).sort(), ['events', 'generatedAt', 'refs', 'summary', 'tasks']);
  assert.equal(data.tasks[0].limit, MAX_LIMIT);
  assert.equal(data.events[0].payload.text, 'hi');
});

test('AgentGit API accepts GET and rejects mutations', async () => {
  const handler = createAgentGitApiHandler(storeFixture());
  const get = response();
  await handler({ method: 'GET', url: '/agentgit/api?limit=2' }, get);
  assert.equal(get.status, 200);
  assert.equal(JSON.parse(get.body).events.length, 1);
  const post = response();
  await handler({ method: 'POST', url: '/agentgit/api' }, post);
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET');
});
