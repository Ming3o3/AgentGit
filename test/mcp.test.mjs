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
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['send_message', 'read_inbox', 'acknowledge_message', 'get_event', 'task_history']);
  const sent = await client.callTool({ name: 'send_message', arguments: { to: ['reviewer'], text: 'Please review checkpoint c1', task_id: 'task-1', references: ['checkpoint:c1'] } });
  const message = JSON.parse(sent.content[0].text);
  assert.equal(message.agentId, 'coder');
  const store = new EventStore(repo);
  assert.equal(store.inbox({ agentId: 'reviewer' }).length, 1);
  const history = await client.callTool({ name: 'task_history', arguments: { task_id: 'task-1' } });
  assert.equal(JSON.parse(history.content[0].text)[0].type, 'message.sent');
  const inbox = await client.callTool({ name: 'read_inbox', arguments: {} });
  assert.equal(JSON.parse(inbox.content[0].text).length, 0);
  const ackClient = new Client({ name: 'agentgit-reviewer-test', version: '0.1.0' }, { capabilities: {} });
  const ackTransport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('src/mcp-server.mjs'), '--repo', repo, '--agent', 'reviewer'], cwd: path.resolve('.') });
  await ackClient.connect(ackTransport);
  const reviewerInbox = await ackClient.callTool({ name: 'read_inbox', arguments: {} });
  const received = JSON.parse(reviewerInbox.content[0].text)[0];
  assert.equal(received.delivery.status, 'pending');
  const ack = await ackClient.callTool({ name: 'acknowledge_message', arguments: { event_id: received.id } });
  assert.equal(JSON.parse(ack.content[0].text).status, 'acknowledged');
  await client.close();
  await ackClient.close();
  store.close();
});
