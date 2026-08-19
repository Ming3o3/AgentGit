#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { EventStore } from './store.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    result[argv[index].slice(2).replaceAll('-', '_')] = argv[index + 1]?.startsWith('--') ? true : argv[++index];
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
const repo = options.repo ?? process.env.AGENTGIT_REPO;
const agentId = options.agent ?? process.env.AGENTGIT_AGENT_ID;
if (!repo || !agentId) {
  console.error('agentgit-mcp requires --repo and --agent, or AGENTGIT_REPO and AGENTGIT_AGENT_ID');
  process.exit(1);
}

const store = new EventStore(repo);
const server = new McpServer(
  { name: 'agentgit', version: '0.1.0' },
  {
    instructions: 'AgentGit is the collaboration layer for this agent. Read your inbox at the start and end of a task. Send concise messages with references to task or checkpoint events. Acknowledge messages after you have acted on them. Do not claim work is complete without a checkpoint or an explicit result.',
  },
);

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

server.registerTool('send_message', {
  title: 'Send message to agents',
  description: 'Send a durable message to one or more AgentGit recipients. The sender is the configured local agent.',
  inputSchema: {
    to: z.array(z.string().min(1)).min(1).describe('Recipient agent IDs'),
    text: z.string().min(1).describe('Message body'),
    subject: z.string().nullable().optional().describe('Optional short subject'),
    task_id: z.string().nullable().optional().describe('Optional task ID'),
    references: z.array(z.string()).optional().describe('Event IDs or Git checkpoint references'),
  },
}, async ({ to, text, subject = null, task_id: taskId = null, references = [] }) => result(store.sendMessage({
  from: agentId, to, text, subject, taskId, references,
})));

server.registerTool('read_inbox', {
  title: 'Read agent inbox',
  description: 'Read messages addressed to the configured local agent. Use status=pending for unacknowledged work.',
  inputSchema: {
    status: z.enum(['pending', 'delivered', 'acknowledged']).nullable().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
}, async ({ status = null, limit = 100 }) => result(store.inbox({ agentId, status, limit })));

server.registerTool('acknowledge_message', {
  title: 'Acknowledge message',
  description: 'Mark a message as acted on by the configured local agent.',
  inputSchema: { event_id: z.string().min(1).describe('Message event ID') },
}, async ({ event_id: eventId }) => result(store.acknowledge(eventId, agentId)));

server.registerTool('get_event', {
  title: 'Get AgentGit event',
  description: 'Read one immutable event by ID, including its causal parents and source metadata.',
  inputSchema: { event_id: z.string().min(1).describe('Event ID') },
}, async ({ event_id: eventId }) => {
  const event = store.get(eventId);
  if (!event) return { isError: true, content: [{ type: 'text', text: `event not found: ${eventId}` }] };
  return result(event);
});

server.registerTool('task_history', {
  title: 'Read task history',
  description: 'Read the chronological immutable event history for a task.',
  inputSchema: {
    task_id: z.string().min(1).describe('Task ID'),
    limit: z.number().int().min(1).max(1000).optional(),
  },
}, async ({ task_id: taskId, limit = 100 }) => result(store.list({ taskId, limit })));

const transport = new StdioServerTransport();
const shutdown = async () => {
  store.close();
  await server.close().catch(() => {});
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.connect(transport).catch(async (error) => {
  console.error(`agentgit-mcp: ${error.message}`);
  await shutdown();
  process.exit(1);
});
