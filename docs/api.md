# API reference

AgentGit has three public interfaces: the `agentgit` CLI, project-scoped MCP
tools, and a read-only local dashboard endpoint. JSON field names differ by
surface: CLI output uses camelCase, MCP input uses snake_case, and the DeepSeek
Harness tools use camelCase.

## Common response types

### Event

See the canonical [event envelope](architecture.md#event-envelope). Commands
that append an event return that event. `show` returns an event or JSON `null`.

### Task

```json
{
  "id": "task_...",
  "title": "Implement login",
  "description": "",
  "priority": "high",
  "status": "in_progress",
  "createdBy": "planner",
  "assigneeId": "coder",
  "blockedReason": null,
  "createdEventId": "evt_...",
  "updatedEventId": "evt_...",
  "createdAt": "2026-09-12T08:00:00.000Z",
  "updatedAt": "2026-09-12T08:10:00.000Z",
  "completedAt": null
}
```

Priorities are `low`, `normal`, `high`, and `urgent`. Statuses are `open`,
`assigned`, `in_progress`, `blocked`, `completed`, and `cancelled`.

### Delivery

Inbox events add a `delivery` object with `eventId`, `recipientId`, `status`,
`createdAt`, `deliveredAt`, and `acknowledgedAt`. Status is `pending`,
`delivered`, or `acknowledged`.

## CLI

All successful data commands write formatted JSON to stdout. Diagnostics go to
stderr. Invalid input and a failed integrity audit set a nonzero exit status.
Unless stated otherwise, `--repo` is required and limits default to 100.
`--compact` prints JSON on one line. `agentgit --help`, `agentgit help`, and a
command followed by `--help` print usage and exit successfully.

| Command | Required arguments | Optional arguments | Result or effect |
| --- | --- | --- | --- |
| `init [repo]` | none | repository defaults to `.` | Initialize or migrate `.agentgit/`; return repository and database paths |
| `emit` | `--repo`, `--agent`, `--type`, `--payload <object-json>` | `--task`, `--session`, `--causation`, `--ref` | Append and return a custom event |
| `log` | `--repo` | `--ref`, `--task`, `--agent`, `--type`, `--limit` | Return matching events in local sequence order |
| `show` | `--repo`, positional event ID | none | Return one event or `null` |
| `state` | `--repo`, `--at <event-id\|sequence>` | `--task` | Replay event-derived task state and counts through the boundary |
| `verify` | `--repo`, event ID or `--all` | none | Verify one event hash or audit the entire store |
| `import-codex` | `--repo`, `--file`, `--agent` | `--task`, `--session`, `--ref` | Import complete Codex JSONL records from a resumable cursor |
| `export` | `--repo`, `--file` | `--overwrite` | Write a versioned, verified full-store event bundle |
| `backup` | `--repo`, `--file` | `--overwrite` | Alias of `export` for operational workflows |
| `import` | `--repo`, `--file` | `--replace-mutable` | Restore an event bundle into an empty store or re-import the same history |
| `schema-status` | `--repo` | none | Inspect compatibility and pending migrations without changing the database |
| `watch-codex` | `--repo`, `--dir`, `--agent` | `--task`, `--interval` (minimum 50 ms), `--once` | Recursively watch `rollout-*.jsonl` files or scan once |
| `send` | `--repo`, `--from`, `--to <csv>`, `--text` | `--subject`, `--task`, `--session`, `--causation`, `--ref` | Append one message and create per-recipient deliveries |
| `inbox` | `--repo`, `--agent` | `--status`, `--limit`, `--peek` | Return messages; without `--peek`, pending rows become delivered |
| `ack` | `--repo`, `--agent`, `--event` | none | Idempotently acknowledge an addressed message |
| `task-create` | `--repo`, `--agent`, `--title` | `--description`, `--priority`, `--session` | Return `{ event, task }` |
| `task-assign` | `--repo`, `--agent`, `--task`, `--to` | `--note` | Return `{ event, task }` |
| `task-status` | `--repo`, `--agent`, `--task`, `--status` | `--summary` | Return `{ event, task }` |
| `tasks` | `--repo` | `--agent` (assignee), `--status`, `--limit` | Return current task projections |
| `rebuild-tasks` | `--repo` | none | Atomically rebuild tasks; return `{ events }` |
| `metrics` | `--repo` | `--window` 1-10080 minutes | Return local event, workflow, ingest, and storage metrics |
| `health` | `--repo` | `--window`, `--pending-age` 0-10080 minutes, `--no-verify` | Return alerts; exit 0 healthy, 1 degraded, or 2 unhealthy |
| `checkpoint` | `--repo`, `--agent`, `--summary` | `--task`, `--session`, `--ref`, `--commit` | Optionally commit Git, store the diff object, and return the checkpoint event |
| `codex-config` | `--repo`, `--agent` | none | Print a project-scoped TOML MCP configuration block |
| `serve` | `--repo` | `--host` (default `127.0.0.1`), `--port` (default `3210`) | Run the dashboard until SIGINT or SIGTERM |

`emit` is intentionally low level. Built-in `task.*` event types still enforce
their payload and lifecycle invariants, so use task commands for normal work.

## MCP server

Start `agentgit-mcp --repo <path> --agent <id>`, or set `AGENTGIT_REPO` and
`AGENTGIT_AGENT_ID`. The configured identity is the sender/actor and cannot be
overridden per call. Tool results contain one text content item holding
formatted JSON. Protocol/schema errors and store errors are MCP tool errors.

| Tool | Input | Result and side effects |
| --- | --- | --- |
| `send_message` | `to: string[]`, `text: string`; optional nullable `subject`, `task_id`, `causation_event_id`; optional `references: string[]` | Message event; creates pending delivery rows |
| `read_inbox` | optional nullable `status`; optional `limit` 1-500 | Message events; returned pending rows become delivered |
| `acknowledge_message` | `event_id` | Delivery; repeated calls remain acknowledged |
| `get_event` | `event_id` | Event; missing IDs return an MCP error result |
| `state_at` | exactly one of `event_id`, `sequence`; optional nullable `task_id` | Historical boundary, event/task counts, and task projection(s); read-only |
| `get_metrics` | optional `window_minutes` 1-10080 | Operational metrics; read-only |
| `health_check` | optional `window_minutes`, `pending_age_minutes` 0-10080, `verify` | Health status, alerts, metrics, and optional integrity audit; read-only |
| `task_history` | `task_id`; optional `limit` 1-1000 | Chronological task events |
| `create_task` | `title`; optional `description`, `priority` | `{ event, task }` |
| `assign_task` | `task_id`, `assignee_id`; optional nullable `note` | `{ event, task }` |
| `update_task_status` | `task_id`, non-open `status`; optional nullable `summary` | `{ event, task }` |
| `list_tasks` | optional nullable `assignee_id`, `status`; optional `limit` 1-500 | Current task projections |
| `create_checkpoint` | `summary`; optional nullable `task_id`; optional `commit` | Checkpoint event; `commit: true` stages and commits the worktree first |
| `verify_history` | none | Full integrity audit; read-only |
| `rebuild_task_projection` | none | `{ events }`; replaces only the derived task table |

## DeepSeek Harness tools

The native plugin prefixes tools with `agentgit_`. It provides equivalent
messaging, task, checkpoint, audit, and projection-rebuild operations. Its
parameter names are camelCase: for example `taskId`, `assigneeId`, and
`causationEventId`. `agentgit_update_task` can atomically apply `assigneeId`
and/or `status`; at least one is required. Harness query limits are 1-10000.
`agentgit_state_at` accepts exactly one of `eventId` and `sequence`, plus an
optional `taskId`.
`agentgit_get_metrics` and `agentgit_health_check` use camelCase
`windowMinutes`, `pendingAgeMinutes`, and `verify` parameters.

### Metrics and health responses

Metrics contain:

| Group | Fields |
| --- | --- |
| `events` | Total and in-window counts, per-minute rate, counts by type |
| `messages` | Message-event and delivery counts, status counts, oldest pending age, delivery and acknowledgement latency summaries |
| `tasks` | Counts by status and completion-duration summary |
| `ingest` | Source count and most recent cursor update/age |
| `storage` | SQLite, WAL, object count/bytes, and combined bytes |

Latency summaries provide `samples`, `averageMs`, `p95Ms`, and `maximumMs`.
Health adds `status`, structured `alerts`, the metrics snapshot, and either a
full `integrity` audit or `null` when verification was disabled. Alert codes
are `history_integrity_failed`, `capture_failures`, `blocked_tasks`, and
`stale_pending_messages`.

### Historical state response

`state`, `state_at`, and `agentgit_state_at` return:

```json
{
  "asOf": {
    "eventId": "evt_...",
    "sequence": 42,
    "createdAt": "2026-09-12T08:30:00.000Z"
  },
  "summary": {
    "events": 42,
    "agents": 3,
    "eventTypes": { "task.created": 2 },
    "tasks": { "completed": 1, "in_progress": 1 }
  },
  "tasks": []
}
```

When a task filter is supplied, `task` replaces `tasks` and is `null` if that
task did not exist at the boundary. The snapshot replays immutable task events
in local sequence order. Delivery status and refs are excluded because their
historical transitions are not currently immutable events.

Plugin configuration:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `repo` | string | required | Target project path |
| `agentId` | string | required | Local actor identity |
| `captureSessionEvents` | boolean | `true` | Import observable Harness session events |
| `captureToolResults` | boolean | `true` | Import completed tool results |

## Dashboard HTTP API

The standalone dashboard exposes two endpoints:

```http
GET /api/overview
GET /api/events/:eventId/context
```

`/api/overview` returns
`{ repo, generatedAt, summary, metrics, health, tasks, events, refs }`.
`summary` contains counts grouped by task and delivery status plus total
distinct agents and events. `metrics` is the same operational snapshot exposed
by `metrics`; `health` contains the lightweight status and alerts without a
full integrity audit.

`/api/events/:eventId/context` returns
`{ event, parents, causation, children, effects }`. `causation` is either one
event or `null`; all other relationship fields are arrays. An unknown event
returns 404. Both endpoints are read-only, uncached, unauthenticated, and
intended for loopback access. Other methods return 405 and unknown paths return
404.

The Harness plugin exposes a similar bounded read model at
`GET /agentgit/api`; it accepts an optional `limit` query parameter. Pass
`eventId` instead to return the same event context shape, for example
`GET /agentgit/api?eventId=evt_...`.

## Error contract

Common store errors include missing parent or causation events, invalid task
transitions, unknown tasks, invalid recipients, unsupported future database
versions, invalid query limits, and object integrity failures. Mutating
operations use transactions: an error does not leave the event and its
projection half-written.

### Event bundle format

Format identifier `agentgit.event-bundle`, version `1`, contains:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Source AgentGit database schema version |
| `exportedAt` | ISO timestamp for bundle creation |
| `events` | Complete events with their stable local `sequence` |
| `refs` | Named event heads at export time |
| `deliveries` | Per-recipient delivery snapshot |
| `sourceEvents`, `ingestCursors` | Idempotent importer state |
| `objects` | Referenced object bytes encoded as base64 |
| `bundleHash` | SHA-256 of the canonical JSON body excluding this field |

Import accepts only format version 1 and a source schema no newer than the
installed AgentGit. It validates the complete bundle before database mutation.
An existing destination must contain either zero events or the exact same full
event history. With the latter, immutable events are skipped and mutable state
is preserved unless `--replace-mutable` is explicitly set.
