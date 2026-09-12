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

The current release does not provide an online backup command. For a consistent
manual backup:

1. Stop the watcher, MCP server, Harness plugin, dashboard, and any CLI writers
   for the target project.
2. Run `agentgit verify --repo <project> --all`.
3. Copy the entire `.agentgit/` directory, including `events.db` and
   `objects/`, to the backup location.
4. Keep the target project's Git commit or bundle with the backup when Git
   checkpoint restoration matters.

Copying only `events.db` while writers are active can omit WAL changes. Copying
only the database also loses externalized payloads and checkpoint diffs.

## Restore

Restore into an unused target project path or while every AgentGit process for
the target is stopped:

1. Preserve the existing `.agentgit/` directory until the restore is verified.
2. Place the complete backed-up `.agentgit/` directory in the target project.
3. Run `agentgit init <project>` to apply forward-compatible migrations.
4. Run `agentgit verify --repo <project> --all`.
5. Start integrations only after the audit succeeds.

AgentGit supports forward schema upgrades, not schema downgrades. A database
whose recorded schema is newer than the installed AgentGit version is rejected
without being migrated.

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

## Security notes

- Keep the dashboard on `127.0.0.1`; it has no authentication or TLS.
- Restrict filesystem permissions on `.agentgit/` because events can contain
  source text, prompts, tool output, and file paths.
- Credential redaction recognizes common formats but cannot guarantee that all
  secrets are detected.
- Treat imported session files as sensitive and untrusted input.
