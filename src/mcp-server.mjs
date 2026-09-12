#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { EventStore } from './store.mjs';
import { createCheckpoint } from './git.mjs';

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
    causation_event_id: z.string().min(1).nullable().optional().describe('Optional event this message directly responds to'),
    references: z.array(z.string()).optional().describe('Event IDs or Git checkpoint references'),
  },
}, async ({ to, text, subject = null, task_id: taskId = null, causation_event_id: causationId = null, references = [] }) => result(store.sendMessage({
  from: agentId, to, text, subject, taskId, causationId, references,
})));

server.registerTool('read_inbox', {
  title: 'Read agent inbox',
  description: 'Receive messages addressed to the configured local agent. Pending messages become delivered when returned; acknowledge them only after acting on them.',
  inputSchema: {
    status: z.enum(['pending', 'delivered', 'acknowledged']).nullable().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
}, async ({ status = null, limit = 100 }) => result(store.receiveInbox({ agentId, status, limit })));

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

server.registerTool('state_at', {
  title: 'Read historical AgentGit state',
  description: 'Replay event-derived task state and counts through one event or local sequence without changing current state.',
  inputSchema: {
    event_id: z.string().min(1).nullable().optional().describe('Boundary event ID; mutually exclusive with sequence'),
    sequence: z.number().int().min(1).nullable().optional().describe('Boundary local sequence; mutually exclusive with event_id'),
    task_id: z.string().min(1).nullable().optional().describe('Return only this historical task projection'),
  },
  annotations: { readOnlyHint: true },
}, async ({ event_id: eventId = null, sequence = null, task_id: taskId = null }) => result(store.stateAt({ eventId, sequence, taskId })));

server.registerTool('verify_history', {
  title: 'Verify AgentGit history',
  description: 'Read-only audit of the local event DAG, hashes, refs, deliveries, objects, and task projection.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => result(store.verifyAll()));

server.registerTool('rebuild_task_projection', {
  title: 'Rebuild task projection',
  description: 'Rebuild the mutable task-state projection from immutable task events. Does not modify event history, message delivery state, refs, or Git.',
  inputSchema: {},
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async () => result({ events: store.rebuildTaskProjection() }));

server.registerTool('task_history', {
  title: 'Read task history',
  description: 'Read the chronological immutable event history for a task.',
  inputSchema: {
    task_id: z.string().min(1).describe('Task ID'),
    limit: z.number().int().min(1).max(1000).optional(),
  },
}, async ({ task_id: taskId, limit = 100 }) => result(store.list({ taskId, limit })));

server.registerTool('create_checkpoint', {
  title: 'Create Git checkpoint',
  description: 'Record the current Git branch, commit, status, and a content-addressed diff. Set commit=true only when the current worktree should be committed with this summary.',
  inputSchema: {
    summary: z.string().min(1).describe('Concise description of the completed work'),
    task_id: z.string().nullable().optional(),
    commit: z.boolean().optional().describe('Stage and commit current worktree changes before recording'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, async ({ summary, task_id: taskId = null, commit = false }) => result(createCheckpoint({
  repo, store, agentId, summary, taskId, commit,
})));

server.registerTool('create_task', {
  title: 'Create a task',
  description: 'Create a durable task with a current-state projection. The configured local agent is the creator.',
  inputSchema: {
    title: z.string().min(1),
    description: z.string().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  },
}, async ({ title, description = '', priority = 'normal' }) => result(store.createTask({
  createdBy: agentId, title, description, priority,
})));

server.registerTool('assign_task', {
  title: 'Assign a task',
  description: 'Assign an open, assigned, in-progress, or blocked task to an agent.',
  inputSchema: {
    task_id: z.string().min(1),
    assignee_id: z.string().min(1),
    note: z.string().nullable().optional(),
  },
}, async ({ task_id: taskId, assignee_id: assigneeId, note = null }) => result(store.assignTask({
  taskId, assignedBy: agentId, assigneeId, note,
})));

server.registerTool('update_task_status', {
  title: 'Update task status',
  description: 'Change a task status through its lifecycle. completed and cancelled are terminal.',
  inputSchema: {
    task_id: z.string().min(1),
    status: z.enum(['assigned', 'in_progress', 'blocked', 'completed', 'cancelled']),
    summary: z.string().nullable().optional(),
  },
}, async ({ task_id: taskId, status, summary = null }) => result(store.updateTaskStatus({
  taskId, updatedBy: agentId, status, summary,
})));

server.registerTool('list_tasks', {
  title: 'List tasks',
  description: 'List task state projected from immutable task events.',
  inputSchema: {
    assignee_id: z.string().nullable().optional(),
    status: z.enum(['open', 'assigned', 'in_progress', 'blocked', 'completed', 'cancelled']).nullable().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
}, async ({ assignee_id: assigneeId = null, status = null, limit = 100 }) => result(store.listTasks({ assigneeId, status, limit })));

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
