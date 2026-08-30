import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRegistry from '@deepseek-ai/dsh-tools';
import { CallId } from '@deepseek-ai/dsh-llm';
import { apply, Config, name } from '../dist/index.js';
import { EventStore } from '../../../src/store.mjs';

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agentgit-plugin-'));
  const listeners = new Map();
  const tools = [];
  const effects = [];
  const ctx = {
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); },
    effect(setup) { effects.push(setup()); },
  };
  apply(ctx, { repo, agentId: 'coder', captureSessionEvents: true, captureToolResults: true });
  return { repo, listeners, tools, effects };
}

test('registers Harness tools and imports session events idempotently', async () => {
  const { repo, listeners, tools, effects } = fixture();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'agentgit_read_inbox',
    'agentgit_send_message',
    'agentgit_acknowledge_message',
    'agentgit_create_task',
    'agentgit_update_task',
    'agentgit_task_history',
    'agentgit_list_tasks',
    'agentgit_create_checkpoint',
    'agentgit_verify_history',
  ]);
  const event = { seq: 4, time: 10, type: 'user/message', data: { role: 'user', content: 'hello' } };
  listeners.get('session/event')({ id: 'session-1' }, event);
  listeners.get('session/event')({ id: 'session-1' }, event);
  const store = new EventStore(repo);
  assert.equal(store.list({ limit: 20 }).length, 1);
  assert.equal(store.list({ limit: 20 })[0].type, 'user.message');
  assert.equal(store.verifyAll().valid, true);
  store.close();
  for (const dispose of effects) dispose?.();
});

test('captureSessionEvents disables disposed-session records as well', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agentgit-session-toggle-'));
  const listeners = new Map();
  const effects = [];
  const ctx = {
    tools: { register() { return () => {}; } },
    on(eventName, listener) { listeners.set(eventName, listener); return () => listeners.delete(eventName); },
    effect(setup) { effects.push(setup()); },
  };
  apply(ctx, { repo, agentId: 'coder', captureSessionEvents: false, captureToolResults: false });
  assert.equal(listeners.has('session/event'), false);
  assert.equal(listeners.has('session/disposed'), false);
  const store = new EventStore(repo);
  assert.deepEqual(store.list({ limit: 10 }), []);
  store.close();
  for (const dispose of effects) dispose?.();
});

test('captures Harness tool results with execution identity and content', () => {
  const { repo, listeners, effects } = fixture();
  listeners.get('tools/result')(
    Object.freeze({ callId: 'call-1', name: 'agentgit_create_task', sessionId: 'session-1', arguments: { title: 'Captured' } }),
    Object.freeze({ content: Object.freeze([{ type: 'text', text: '{"ok":true}' }]), meta: { durationMs: 12 } }),
  );
  const store = new EventStore(repo);
  const events = store.list({ type: 'tool.runtime_result', limit: 10 });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, {
    callId: 'call-1',
    name: 'agentgit_create_task',
    arguments: { title: 'Captured' },
    content: [{ type: 'text', text: '{"ok":true}' }],
    meta: { durationMs: 12 },
  });
  assert.equal(events[0].sessionId, 'session-1');
  assert.equal(store.verifyAll().valid, true);
  store.close();
  for (const dispose of effects) dispose?.();
});

test('Harness tool execution writes AgentGit task events', async () => {
  const { repo, tools, effects } = fixture();
  const createTask = tools.find((tool) => tool.name === 'agentgit_create_task');
  const result = await createTask.execute({ title: 'Ship plugin' });
  const parsed = JSON.parse(result);
  assert.equal(parsed.task.title, 'Ship plugin');
  const store = new EventStore(repo);
  assert.equal(store.list({ type: 'task.created', limit: 10 }).length, 1);
  store.close();
  for (const dispose of effects) dispose?.();
});

test('combined Harness task updates are atomic', async () => {
  const { repo, tools, effects } = fixture();
  const createTask = tools.find((tool) => tool.name === 'agentgit_create_task');
  const updateTask = tools.find((tool) => tool.name === 'agentgit_update_task');
  const created = JSON.parse(await createTask.execute({ title: 'Atomic Harness task' }));
  const taskId = created.task.id;
  await assert.rejects(
    () => updateTask.execute({ taskId, assigneeId: 'coder', status: 'completed' }),
    /invalid task transition: assigned -> completed/,
  );
  const store = new EventStore(repo);
  assert.equal(store.getTask(taskId).status, 'open');
  assert.equal(store.getTask(taskId).assigneeId, null);
  assert.deepEqual(store.list({ taskId }).map((event) => event.type), ['task.created']);
  store.close();
  for (const dispose of effects) dispose?.();
});

test('loads as a real Cordis plugin and executes through the Harness registry', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agentgit-cordis-'));
  const root = new Context();
  await root.plugin(SystemPrompt);
  await root.plugin(ToolRegistry);
  await root.plugin({ name, Config, inject: ['tools'], apply }, { repo, agentId: 'coder' });
  const result = await root.tools.execute({
    callId: CallId('runtime-test'),
    name: 'agentgit_create_task',
    arguments: { title: 'Harness task' },
    signal: new AbortController().signal,
  });
  assert.equal(result.content[0].type, 'text');
  assert.match(result.content[0].text, /Harness task/);
  await root.fiber.dispose();
});

test('registers and removes the WebServer API route with the Cordis lifecycle', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agentgit-webserver-lifecycle-'));
  const routes = new Map();
  const webServer = {
    register(route) {
      assert.equal(route.kind, 'exact');
      assert.equal(route.path, '/agentgit/api');
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const root = new Context();
  await root.plugin(SystemPrompt);
  await root.plugin(ToolRegistry);
  root.provide('webServer', webServer);
  const fiber = await root.plugin({ name, Config, inject: ['tools'], apply }, { repo, agentId: 'coder' });

  assert.equal(routes.size, 1);
  const response = {
    headers: {},
    status: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(value) { this.body = value; },
  };
  await routes.get('/agentgit/api').handler({ method: 'GET', url: '/agentgit/api?limit=1' }, response);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).summary.events, 0);

  await fiber.dispose();
  assert.equal(routes.size, 0);
  const reopened = new EventStore(repo);
  assert.deepEqual(reopened.list({ limit: 1 }), []);
  reopened.close();
  await root.fiber.dispose();
});
