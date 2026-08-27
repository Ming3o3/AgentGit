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
