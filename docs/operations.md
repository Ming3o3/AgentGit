# Operations and recovery

## Initialize and inspect

Initialize once per target project. Repeating `init` is safe and applies any
pending schema migrations:

```sh
agentgit init /absolute/path/to/project
agentgit verify --repo /absolute/path/to/project --all
```

AgentGit keeps its state under `<project>/.agentgit/` and adds that path to the
repository-local Git exclude file. The directory contains:

```text
.agentgit/
  events.db        SQLite event store and projections
  events.db-wal    present while WAL changes are pending
  events.db-shm    present while processes have the database open
  objects/sha256/  content-addressed payloads and checkpoint diffs
```

Do not edit these files directly. Do not add `.agentgit/` to project commits.

## Integrity checks

Run a full audit after an unexpected shutdown, before a backup, and after a
restore:

```sh
agentgit verify --repo /absolute/path/to/project --all
```

Exit status zero means the audit found no issue. The JSON result includes
`checked` counts and an `issues` array. The audit verifies event hashes, DAG
links, local ordering, refs, deliveries, source cursors, content-addressed
objects, and task projection state. It never repairs data automatically.

## Backup

Create a portable, internally verified backup while the store is online:

```sh
agentgit backup --repo /absolute/path/to/project \
  --file /secure/path/project-agentgit.json
```

The command first audits the source, takes a transactionally consistent read,
includes every referenced object, and writes through a temporary file. It will
not overwrite an existing destination unless `--overwrite` is supplied. Keep
the target project's Git repository or a Git bundle alongside this backup when
source restoration matters; AgentGit checkpoints record Git evidence but the
event bundle is not a replacement for the Git object database.

The event bundle contains source file paths and potentially sensitive observed
content. Store it with permissions appropriate for `.agentgit/` itself.

## Restore

Restore into a target with no AgentGit events:

```sh
agentgit import --repo /absolute/path/to/restored-project \
  --file /secure/path/project-agentgit.json
agentgit verify --repo /absolute/path/to/restored-project --all
```

Import is idempotent for the exact same history. A normal re-import preserves
the destination's current refs, deliveries, and ingest cursors. Add
`--replace-mutable` to restore those projections exactly from the backup. This
flag cannot replace immutable events, and import refuses a destination with a
different or partial history.

AgentGit supports forward schema upgrades, not schema downgrades. A database
whose recorded schema is newer than the installed AgentGit version is rejected
without being migrated.

Inspect the current and supported versions before an upgrade:

```sh
agentgit schema-status --repo /absolute/path/to/project
```

This command is read-only and reports pending migration names without opening
the normal auto-migrating `EventStore`. Take a backup with the currently
installed compatible AgentGit release before upgrading its package. `init` and
all normal store entry points apply pending forward migrations transactionally.

## Projection recovery

If the audit reports only task projection drift, rebuild tasks from immutable
events:

```sh
agentgit rebuild-tasks --repo /absolute/path/to/project
agentgit verify --repo /absolute/path/to/project --all
```

This replaces the `tasks` table atomically. It does not change events, refs,
deliveries, import cursors, objects, or Git. There is currently no automatic
repair for delivery or ref corruption; preserve the store and diagnose the
audit output before changing anything.

Missing or hash-mismatched immutable events and objects cannot be reconstructed
from projections. Restore them from a known-good complete backup.

## Codex ingest recovery

Codex import is idempotent by source key and byte offset. The cursor includes a
fingerprint of the already-read prefix. If a rollout is truncated or rewritten,
the importer restarts that source and deduplicates already recorded positions
for the new source generation.

Use `watch-codex --once` to diagnose one scan without leaving a process running:

```sh
agentgit watch-codex --repo /absolute/path/to/project \
  --dir /absolute/path/to/codex/sessions --agent coder --once
```

## Common failures

| Symptom | Action |
| --- | --- |
| `SQLITE_BUSY` after the built-in retry window | Confirm no stuck process or filesystem issue; do not delete WAL files |
| `unsupported AgentGit schema version` | Install the AgentGit version that created the database or a newer one |
| `event_hash_mismatch` or `object_hash_mismatch` | Stop writers and restore from a verified backup |
| `task_projection_*` issue only | Run `rebuild-tasks`, then audit again |
| `parent event does not exist` | Correct the supplied parent/ref; the failed append wrote nothing |
| Dashboard port already in use | Select another `--port`; the event store remains usable |
| Harness `capture.failed` event | Inspect the event's redacted error and source, correct the integration, then verify history |

## Monitoring and exit codes

Use `metrics` for trends and `health` for actionable state:

```sh
agentgit metrics --repo /absolute/path/to/project --window 60
agentgit health --repo /absolute/path/to/project --window 60 --pending-age 15
```

Health exit codes are stable for shell automation:

| Exit | Status | Meaning |
| --- | --- | --- |
| 0 | `healthy` | No configured condition is active |
| 1 | `degraded` | One or more warning conditions are active |
| 2 | `unhealthy` | A capture or integrity failure is active |

The default health check audits the full immutable history and every referenced
object. For frequent lightweight polling, `--no-verify` keeps workflow alerts
but returns `integrity: null`. Schedule a separate verified check so integrity
coverage is not lost.

AgentGit does not deliver external notifications. A local scheduler can inspect
the exit code and route the JSON report to an existing monitoring system.

## Security notes

- Keep the dashboard on `127.0.0.1`; it has no authentication or TLS.
- Restrict filesystem permissions on `.agentgit/` because events can contain
  source text, prompts, tool output, and file paths.
- Credential redaction recognizes common formats but cannot guarantee that all
  secrets are detected.
- Treat imported session files as sensitive and untrusted input.
