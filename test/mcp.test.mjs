import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initRepository, EventStore } from '../src/store.mjs';

function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-mcp-')); }

test('exposes durable messaging through MCP stdio', async () => {
  const repo = tempRepo();
  initRepository(repo);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('src/mcp-server.mjs'), '--repo', repo, '--agent', 'coder'],
    cwd: path.resolve('.'),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agentgit-test-client', version: '0.1.0' }, { capabilities: {} });
  const ackClient = new Client({ name: 'agentgit-reviewer-test', version: '0.1.0' }, { capabilities: {} });
  const ackTransport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/mcp-server.mjs'), '--repo', repo, '--agent', 'reviewer'], cwd: path.resolve('.') });
  const store = new EventStore(repo);
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      'send_message', 'read_inbox', 'acknowledge_message', 'get_event', 'verify_history', 'rebuild_task_projection', 'task_history', 'create_checkpoint',
      'create_task', 'assign_task', 'update_task_status', 'list_tasks',
    ]);
    const sent = await client.callTool({ name: 'send_message', arguments: { to: ['reviewer'], text: 'Please review checkpoint c1', task_id: 'task-1', references: ['checkpoint:c1'] } });
    const message = JSON.parse(sent.content[0].text);
    assert.equal(message.agentId, 'coder');
    assert.equal(store.inbox({ agentId: 'reviewer' }).length, 1);
    const history = await client.callTool({ name: 'task_history', arguments: { task_id: 'task-1' } });
    assert.equal(JSON.parse(history.content[0].text)[0].type, 'message.sent');
    const audit = await client.callTool({ name: 'verify_history', arguments: {} });
    assert.equal(JSON.parse(audit.content[0].text).valid, true);
    const inbox = await client.callTool({ name: 'read_inbox', arguments: {} });
    assert.equal(JSON.parse(inbox.content[0].text).length, 0);
    const taskResult = await client.callTool({ name: 'create_task', arguments: { title: 'Review authentication', priority: 'high' } });
    const task = JSON.parse(taskResult.content[0].text).task;
    assert.equal(task.status, 'open');
    await client.callTool({ name: 'assign_task', arguments: { task_id: task.id, assignee_id: 'reviewer' } });
    await client.callTool({ name: 'update_task_status', arguments: { task_id: task.id, status: 'in_progress' } });
    const tasksResult = await client.callTool({ name: 'list_tasks', arguments: { status: 'in_progress' } });
    assert.equal(JSON.parse(tasksResult.content[0].text)[0].id, task.id);
    const rebuilt = await client.callTool({ name: 'rebuild_task_projection', arguments: {} });
    assert.equal(JSON.parse(rebuilt.content[0].text).events, 3);
    await ackClient.connect(ackTransport);
    const reviewerInbox = await ackClient.callTool({ name: 'read_inbox', arguments: {} });
    const received = JSON.parse(reviewerInbox.content[0].text)[0];
    assert.equal(received.delivery.status, 'delivered');
    const reply = await ackClient.callTool({ name: 'send_message', arguments: {
      to: ['coder'], text: 'Review started', causation_event_id: received.id,
    } });
    assert.equal(JSON.parse(reply.content[0].text).causationId, received.id);
    const ack = await ackClient.callTool({ name: 'acknowledge_message', arguments: { event_id: received.id } });
    assert.equal(JSON.parse(ack.content[0].text).status, 'acknowledged');
  } finally {
    await client.close().catch(() => {});
    await ackClient.close().catch(() => {});
    await transport.close().catch(() => {});
    await ackTransport.close().catch(() => {});
    store.close();
  }
});
