import { URL } from 'node:url';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function boundedLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function eventView(event) {
  return {
    id: event.id,
    taskId: event.taskId ?? null,
    sessionId: event.sessionId ?? null,
    agentId: event.agentId,
    type: event.type,
    parents: event.parents ?? [],
    causationId: event.causationId ?? null,
    payload: event.payload ?? {},
    source: event.source ?? null,
    createdAt: event.createdAt,
    contentHash: event.contentHash,
  };
}

/** Build the read-only projection consumed by the Web UI. */
export function dashboardData(store, query = {}) {
  const limit = boundedLimit(query.limit);
  return {
    generatedAt: new Date().toISOString(),
    summary: store.dashboardSummary(),
    tasks: store.listTasks({ limit }),
    events: store.recentEvents({ limit }).map(eventView),
    refs: store.refs(),
  };
}

/** Create a Harness WebServer-compatible AgentGit API handler. */
export function createAgentGitApiHandler(store) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      json(res, 405, { error: 'method_not_allowed' });
      return;
    }
    try {
      const url = new URL(req.url ?? '/agentgit/api', 'http://agentgit.local');
      json(res, 200, dashboardData(store, { limit: url.searchParams.get('limit') }));
    } catch (error) {
      json(res, 500, { error: 'agentgit_api_failed', message: error instanceof Error ? error.message : String(error) });
    }
  };
}

export { MAX_LIMIT };
