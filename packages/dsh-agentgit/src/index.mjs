import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { initRepository, EventStore } from '../../../src/store.mjs';
import { createCheckpoint } from '../../../src/git.mjs';
import { redactText } from '../../../src/payload.mjs';
import { createAgentGitApiHandler } from './web-route.mjs';

export const name = 'agentgit';
export const inject = ['tools'];

export const Config = Schema.object({
  repo: Schema.string().required(),
  agentId: Schema.string().required(),
  captureSessionEvents: Schema.boolean().default(true),
  captureToolResults: Schema.boolean().default(true),
});

const SESSION_EVENT_TYPES = {
  'user/message': 'user.message',
  'assistant/message': 'agent.message',
  'assistant/chunk': 'agent.chunk',
  'tool/call': 'tool.called',
  'tool/result': 'tool.completed',
  'turn/start': 'turn.started',
  'turn/end': 'turn.ended',
  'step/start': 'step.started',
  'step/end': 'step.ended',
  'compaction/start': 'session.compaction.started',
  'compaction/summary': 'session.compaction.summary',
  'compaction/end': 'session.compaction.ended',
};

function sessionIdOf(session) {
  return session?.id == null ? null : String(session.id);
}

function sessionPayload(event) {
  return {
    data: event?.data ?? null,
    seq: Number.isInteger(event?.seq) ? event.seq : null,
    time: Number.isFinite(event?.time) ? event.time : null,
    ...(event?.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}),
    ...(event?.sourceEventSeqs !== undefined ? { sourceEventSeqs: event.sourceEventSeqs } : {}),
    ...(event?.ignorable ? { ignorable: true } : {}),
  };
}

function sourceForSession(session, event) {
  const sessionId = sessionIdOf(session);
  return {
    adapter: 'deepseek-harness',
    sessionId,
    sourceEventId: sessionId && Number.isInteger(event?.seq) ? `${sessionId}:${event.seq}` : null,
    sequence: Number.isInteger(event?.seq) ? event.seq : null,
    eventType: event?.type ?? null,
    eventTime: Number.isFinite(event?.time) ? event.time : null,
  };
}

function runtimeValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return value;
  return String(value);
}

function textResult(_args, value) {
  return [{ type: 'text', text: value }];
}

function objectTool(ctx, spec) {
  ctx.tools.register(defineTool({
    ...spec,
    output: spec.output ?? { schema: { type: 'string' }, render: textResult },
    async execute(args) {
      const value = await spec.execute(args);
      return JSON.stringify(value, null, 2);
    },
  }));
}

function arrayTool(ctx, spec) {
  ctx.tools.register(defineTool({
    ...spec,
    output: spec.output ?? { schema: { type: 'string' }, render: textResult },
    async execute(args) {
      const value = await spec.execute(args);
      return JSON.stringify(value, null, 2);
    },
  }));
}

function stringParameter(required = false, description) {
  return { type: 'string', ...(required ? { required: true } : {}), ...(description ? { description } : {}) };
}

function registerTools(ctx, store, config) {
  arrayTool(ctx, {
    name: 'agentgit_read_inbox',
    description: 'Read durable messages addressed to the configured AgentGit agent. Pending messages become delivered.',
    parameters: {
      status: stringParameter(false, 'Optional delivery status: pending, delivered, or acknowledged.'),
      limit: { type: 'number', description: 'Maximum number of messages to return.' },
    },
    async execute(args) {
      return store.receiveInbox({
        agentId: config.agentId,
        status: args?.status ?? null,
        limit: args?.limit ?? 100,
      });
    },
  });

  objectTool(ctx, {
    name: 'agentgit_send_message',
    description: 'Send a durable message to one or more AgentGit agents.',
    parameters: {
      to: { type: 'array', required: true, description: 'Recipient agent IDs.', items: { type: 'string' } },
      text: stringParameter(true, 'Message body.'),
      subject: stringParameter(false, 'Optional subject.'),
      taskId: stringParameter(false, 'Optional related task ID.'),
      causationEventId: stringParameter(false, 'Event ID this message responds to.'),
      references: { type: 'array', items: { type: 'string' }, description: 'Event or checkpoint references.' },
    },
    async execute(args) {
      return store.sendMessage({
        from: config.agentId,
        to: args.to,
        text: args.text,
        subject: args.subject ?? null,
        taskId: args.taskId ?? null,
        causationId: args.causationEventId ?? null,
        references: args.references ?? [],
        ref: `agent/${config.agentId}`,
      });
    },
  });

  objectTool(ctx, {
    name: 'agentgit_acknowledge_message',
    description: 'Acknowledge that the configured AgentGit agent acted on a message.',
    parameters: { eventId: stringParameter(true, 'Message event ID.') },
    async execute(args) {
      return store.acknowledge(args.eventId, config.agentId);
    },
  });

  objectTool(ctx, {
    name: 'agentgit_create_task',
    description: 'Create a durable AgentGit task.',
    parameters: {
      title: stringParameter(true, 'Task title.'),
      description: stringParameter(false, 'Task description.'),
      priority: stringParameter(false, 'low, normal, high, or urgent.'),
    },
    async execute(args) {
      return store.createTask({
        createdBy: config.agentId,
        title: args.title,
        description: args.description ?? '',
        priority: args.priority ?? 'normal',
      });
    },
  });

  objectTool(ctx, {
    name: 'agentgit_update_task',
    description: 'Assign a task and/or move it through its lifecycle.',
    parameters: {
      taskId: stringParameter(true, 'Task ID.'),
      assigneeId: stringParameter(false, 'Agent to assign.'),
      note: stringParameter(false, 'Assignment note.'),
      status: stringParameter(false, 'assigned, in_progress, blocked, completed, or cancelled.'),
      summary: stringParameter(false, 'Status transition summary.'),
    },
    async execute(args) {
      if (!args.assigneeId && !args.status) throw new Error('agentgit_update_task requires assigneeId or status');
      return store.updateTask({
        taskId: args.taskId,
        updatedBy: config.agentId,
        assigneeId: args.assigneeId ?? null,
        note: args.note ?? null,
        status: args.status ?? null,
        summary: args.summary ?? null,
      });
    },
  });

  arrayTool(ctx, {
    name: 'agentgit_task_history',
    description: 'Read the immutable event history for a task.',
    parameters: {
      taskId: stringParameter(true, 'Task ID.'),
      limit: { type: 'number' },
    },
    async execute(args) {
      return store.list({ taskId: args.taskId, limit: args.limit ?? 100 });
    },
  });

  arrayTool(ctx, {
    name: 'agentgit_list_tasks',
    description: 'List task state reconstructed from immutable task events.',
    parameters: {
      assigneeId: stringParameter(false, 'Optional agent ID to filter by assignee.'),
      status: stringParameter(false, 'Optional task status.'),
      limit: { type: 'number' },
    },
    async execute(args) {
      return store.listTasks({ assigneeId: args?.assigneeId ?? null, status: args?.status ?? null, limit: args?.limit ?? 100 });
    },
  });

  objectTool(ctx, {
    name: 'agentgit_create_checkpoint',
    description: 'Record the current Git state and a content-addressed diff as an AgentGit checkpoint.',
    parameters: {
      summary: stringParameter(true, 'Concise description of the work.'),
      taskId: stringParameter(false, 'Optional related task ID.'),
      commit: { type: 'boolean', description: 'Commit current worktree before recording.' },
    },
    async execute(args) {
      return createCheckpoint({
        repo: config.repo,
        store,
        agentId: config.agentId,
        summary: args.summary,
        taskId: args.taskId ?? null,
        ref: `agent/${config.agentId}`,
        commit: args.commit === true,
      });
    },
  });

  objectTool(ctx, {
    name: 'agentgit_verify_history',
    description: 'Audit event hashes, causal parents, deliveries, objects, refs, and task projections.',
    parameters: {},
    async execute() {
      return store.verifyAll();
    },
  });

  objectTool(ctx, {
    name: 'agentgit_rebuild_task_projection',
    description: 'Rebuild the mutable task projection from immutable task events without changing event history.',
    parameters: {},
    async execute() {
      return { events: store.rebuildTaskProjection() };
    },
  });
}

function appendCaptured(store, config, build, source) {
  try {
    const input = build();
    return input ? store.append(input) : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agentgit: failed to capture ${source}: ${redactText(message)}`);
    try {
      return store.append({
        agentId: config.agentId,
        type: 'capture.failed',
        ref: `agent/${config.agentId}`,
        payload: { source, error: message },
      });
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      console.error(`agentgit: failed to record capture failure: ${redactText(fallbackMessage)}`);
      return null;
    }
  }
}

export function apply(ctx, config) {
  initRepository(config.repo);
  const store = new EventStore(config.repo);
  // Register the database disposer before listeners/tools so Cordis removes
  // those consumers first and closes SQLite last during plugin teardown.
  ctx.effect(() => () => store.close());
  const recordSessionEvent = (session, event) => {
    if (!config.captureSessionEvents) return;
    appendCaptured(store, config, () => {
      const eventType = event?.type;
      if (!eventType) return null;
      const sessionId = sessionIdOf(session);
      const sourceKey = sessionId ? `harness:${sessionId}` : null;
      const sourceOffset = Number.isInteger(event.seq) ? event.seq : null;
      return {
        agentId: config.agentId,
        type: SESSION_EVENT_TYPES[eventType] ?? `harness.${eventType.replaceAll('/', '.')}`,
        payload: sessionPayload(event),
        sessionId,
        ref: sessionId ? `session/${sessionId}` : `agent/${config.agentId}`,
        source: sourceForSession(session, event),
        ...(sourceKey && sourceOffset !== null ? {
          ingest: {
            sourceKey,
            sourceOffset,
            filePath: `harness://${sessionId}`,
            nextOffset: sourceOffset + 1,
          },
        } : {}),
      };
    }, 'session/event');
  };

  if (config.captureSessionEvents) {
    ctx.on('session/event', recordSessionEvent);
  }

  if (config.captureToolResults) {
    ctx.on('tools/result', (exec, result) => {
      appendCaptured(store, config, () => ({
        agentId: config.agentId,
        type: 'tool.runtime_result',
        sessionId: exec?.sessionId == null ? null : String(exec.sessionId),
        ref: `agent/${config.agentId}`,
        payload: {
          callId: runtimeValue(exec?.callId ?? null),
          name: runtimeValue(exec?.name ?? null),
          arguments: runtimeValue(exec?.arguments ?? null),
          content: runtimeValue(result?.content ?? null),
          meta: runtimeValue(result?.meta ?? null),
        },
        source: { adapter: 'deepseek-harness', event: 'tools/result' },
      }), 'tools/result');
    });
  }

  if (config.captureSessionEvents) {
    ctx.on('session/disposed', (session) => {
      appendCaptured(store, config, () => ({
        agentId: config.agentId,
        type: 'session.disposed',
        sessionId: sessionIdOf(session),
        ref: `agent/${config.agentId}`,
        payload: { sessionId: sessionIdOf(session) },
        source: { adapter: 'deepseek-harness', event: 'session/disposed' },
      }), 'session/disposed');
    });
  }

  registerTools(ctx, store, config);

  // Host-only/test deployments may not provide WebServer. In a full Harness
  // Web profile this nested injection becomes active when the service exists.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/agentgit/api',
        handler: createAgentGitApiHandler(store),
      });
      return () => dispose();
    });
  } else if (ctx.webServer?.register) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/agentgit/api',
      handler: createAgentGitApiHandler(store),
    }));
  }
}
