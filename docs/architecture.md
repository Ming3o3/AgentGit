# Architecture and data model

## Product boundary

AgentGit is a local collaboration record for coding agents that already use a
shared project directory. It adds durable messages, tasks, session observations,
and Git checkpoints without replacing the agent runtime or Git.

The system is deliberately single-store and local-first:

```text
Codex rollout JSONL ----\
DeepSeek Harness events +--> adapters --> EventStore --> SQLite + object files
CLI and MCP commands ---/                         |
                                                  +--> task/delivery projections
                                                  +--> dashboard read models
```

All writers for one project open `<project>/.agentgit/events.db`. SQLite WAL
mode and immediate write transactions provide the concurrency boundary. There
is no remote transport, leader election, distributed identity, or cross-machine
ref reconciliation.

## Components

| Component | Responsibility |
| --- | --- |
| `src/store.mjs` | Immutable event writes, mutable projections, queries, migrations, and integrity audits |
| `src/objects.mjs` | Content-addressed storage for large text, binary values, and Git diffs |
| `src/payload.mjs` | Credential redaction, runtime-value normalization, and large-payload externalization |
| `src/bundle.mjs` | Versioned, integrity-checked full-history export and restore |
| `src/git.mjs` | Read Git state and create optional commits and checkpoint events |
| `src/adapters/codex.mjs` | Normalize observable Codex rollout records |
| `src/watcher.mjs` | Resume Codex JSONL ingestion from persisted byte cursors |
| `src/cli.mjs` | Standalone human and automation interface |
| `src/mcp-server.mjs` | Project-scoped stdio tools for MCP clients |
| `src/dashboard-server.mjs` | Local read-only dashboard and JSON endpoint |
| `packages/dsh-agentgit` | Native DeepSeek Harness event, tool, and Web UI integration |

## Event envelope

Every immutable event returned by AgentGit has this shape:

```json
{
  "id": "evt_2ee4a6ac-...",
  "taskId": "task_...",
  "sessionId": "session-123",
  "agentId": "coder",
  "type": "task.status_changed",
  "parents": ["evt_parent"],
  "causationId": "evt_request",
  "payload": { "status": "completed", "summary": "Tests pass" },
  "source": null,
  "createdAt": "2026-09-12T08:30:00.000Z",
  "contentHash": "0123456789abcdef..."
}
```

`taskId`, `sessionId`, `causationId`, and `source` may be `null`. `parents`
forms the event DAG. `causationId` expresses the direct reason for an event and
is separate from ancestry. The hash covers the persisted snake-case envelope,
including the event ID and timestamp.

Events cannot be updated or deleted; SQLite triggers enforce that invariant.
Large payload values are replaced with an object reference such as:

```json
{
  "objectRef": "sha256:...",
  "bytes": 12000,
  "preview": "first 512 characters..."
}
```

Objects live under `.agentgit/objects/<hash-prefix>/<hash-suffix>`. Common credential keys and
token formats are redacted before hashing and persistence. Redaction is a
defense-in-depth measure, not a reason to deliberately send secrets to the
store.

## Mutable projections

The immutable event log is authoritative. These tables are derived or mutable:

| Projection | Purpose | Recovery |
| --- | --- | --- |
| `event_order` | Stable local monotonic sequence | Filled when the store opens and audited by `verify --all` |
| `tasks` | Current task state | `rebuild-tasks` replays task events |
| `deliveries` | Per-recipient delivery and acknowledgement state | Audited, but intentionally not replayed from message events |
| `refs` | Named heads into the event DAG | Audited against existing events |
| `source_events` | Idempotency mapping for imported records | Audited with ingest cursors |
| `ingest_cursors` | Resume position and source-prefix fingerprint | Reconciled by the importer when source files change |

Task lifecycle:

| Current status | Allowed next status |
| --- | --- |
| `open` | `assigned`, `in_progress`, `blocked`, `cancelled` |
| `assigned` | `in_progress`, `blocked`, `cancelled` |
| `in_progress` | `blocked`, `completed`, `cancelled` |
| `blocked` | `in_progress`, `cancelled` |
| `completed`, `cancelled` | none |

`completed` and `cancelled` are terminal. Assignment and status changes that
would violate the lifecycle fail in the same transaction as the event append.

## Ordering and concurrent writers

Timestamps are descriptive and may collide. `event_order.sequence` is the
local deterministic ordering used by histories and the dashboard. An append
uses an immediate transaction, resolves the current ref head while holding the
write lock, records it as the default parent, inserts the event, advances the
sequence, updates projections, and finally advances the ref.

This prevents two local processes from silently replacing the same ref head.
It is concurrency control, not semantic conflict resolution: AgentGit does not
decide which of two proposed code changes or task outcomes is correct. Git and
the collaborating agents still own those decisions.

## Trust and failure model

- AgentGit trusts local processes with filesystem access to `.agentgit/`.
- MCP is local stdio. The dashboard defaults to `127.0.0.1` and has no
  authentication; do not bind it to an untrusted network.
- An event or object modified outside AgentGit is detected by `verify --all`.
- A process crash is contained by SQLite transactions and WAL recovery.
- Projection drift is recoverable only where a replay operation is explicitly
  provided. See [operations.md](operations.md).

## Portable event bundles

The `agentgit.event-bundle` format is a JSON snapshot with its own format
version and canonical SHA-256 hash. It contains ordered immutable events, refs,
deliveries, source mappings, ingest cursors, and base64-encoded content-addressed
objects. Import verifies the bundle hash, every event hash and DAG edge, delivery
chronology, cursor consistency, and every object before restoring database
state.

Bundles are backup and portability artifacts, not a synchronization protocol.
Import accepts an empty event store or an idempotent re-import of the exact same
history. It rejects partial or unrelated destination histories instead of
inventing merge semantics.
