# AgentGit

AgentGit is a local-first collaboration layer for existing coding agents. It
does not replace Codex, Claude Code, Git, or native session storage.

```text
Agent-native session records ──> AgentGit importer ──> immutable event history
MCP tools <───────────────────> inbox / acknowledgements / task history
Git worktree ─────────────────> content-addressed checkpoint and diff
```

AgentGit records only observable collaboration facts: explicit messages, tool
calls and outputs exposed by the source agent, task events, Git checkpoints,
and message-delivery state. It does not record hidden reasoning or tokens.

## Install

```sh
git clone <your-agentgit-repository>
cd AgentGit
npm install
npm test
```

The current implementation requires Node.js 20+ and uses SQLite locally.
AgentGit writes all state to `<target-project>/.agentgit/`. During `init`, it
adds `.agentgit/` to that repository's local `.git/info/exclude`, so plugin
data is never staged by AgentGit checkpoints.

## Initialize a target project

Run AgentGit from its source checkout, pointing at the project that agents
will collaborate on:

```sh
node src/cli.mjs init /absolute/path/to/project
```

## Connect Codex without replacing it

Generate a project-scoped MCP server entry:

```sh
node src/cli.mjs codex-config \
  --repo /absolute/path/to/project \
  --agent coder
```

Paste the printed block into `/absolute/path/to/project/.codex/config.toml`.
The configuration starts AgentGit as a local stdio MCP process; it does not
wrap Codex, change its model, or intercept its terminal.

The MCP tools are:

- `read_inbox` and `acknowledge_message`
- `send_message`
- `get_event` and `task_history`
- `create_checkpoint`

The included Codex plugin skill at [`skills/agentgit/SKILL.md`](skills/agentgit/SKILL.md)
describes the intended collaboration workflow once those tools are configured.

## Observe Codex sessions

Codex keeps explicit session entries in rollout JSONL files. Import a specific
file once:

```sh
node src/cli.mjs import-codex \
  --repo /absolute/path/to/project \
  --file /absolute/path/to/rollout-123.jsonl \
  --agent coder
```

Or run the non-invasive rollout watcher. It has a testable single-scan mode
and otherwise polls safely from persisted byte cursors:

```sh
node src/cli.mjs watch-codex \
  --repo /absolute/path/to/project \
  --dir ~/.codex/sessions \
  --agent coder
```

Only `rollout-*.jsonl` files are read. Every imported event retains its source
path and byte offset, and re-scanning never duplicates already imported rows.

## Communicate outside MCP

The CLI provides the same durable communication protocol:

```sh
node src/cli.mjs send --repo /absolute/path/to/project \
  --from planner --to coder,reviewer \
  --subject "Login task" --text "Implement the login endpoint." \
  --task task-login

node src/cli.mjs inbox --repo /absolute/path/to/project --agent coder
node src/cli.mjs ack --repo /absolute/path/to/project --agent coder --event evt_...
```

Messages are immutable `message.sent` events. Delivery records are separate,
per-recipient mutable state: `pending`, `delivered`, and `acknowledged`.
Reading an inbox marks returned pending messages as `delivered`; use `ack` only
after the recipient has acted on the message. Add `--peek` when inspecting an
inbox without changing delivery state.

When a message is an explicit response to another event, pass its ID through
`--causation evt_...` (or `causation_event_id` in MCP). This creates a durable
causal edge in the event DAG; use `references` for related evidence that is not
the direct cause of the response.

Each event is also assigned a local monotonic sequence in a rebuildable
projection. This makes timelines and inboxes deterministic even when multiple
events share the same timestamp, without changing the immutable event hash.
Writes take the SQLite write lock before resolving a ref head, so concurrent
agents append to one ref as a single causal chain rather than racing to replace
the head.

Audit the whole local history at any time. It is read-only and checks event
hashes, DAG links, refs, delivery rows, content-addressed objects, ordering,
and the task projection:

```sh
node src/cli.mjs verify --repo /absolute/path/to/project --all
```

The same audit is available to configured agents through the `verify_history`
MCP tool.

## Tasks

Tasks are event-sourced. The immutable history uses `task.created`,
`task.assigned`, and `task.status_changed`; the `tasks` SQLite table is a
rebuildable current-state projection. Allowed lifecycle transitions are:

```text
open -> assigned -> in_progress -> completed
                       |
                       v
                    blocked -> in_progress
```

`cancelled` is available before completion, while `completed` and `cancelled`
are terminal. Create and route a task through the CLI:

```sh
node src/cli.mjs task-create --repo /absolute/path/to/project \
  --agent planner --title "Implement login" --priority high

node src/cli.mjs task-assign --repo /absolute/path/to/project \
  --agent planner --task task_... --to coder

node src/cli.mjs task-status --repo /absolute/path/to/project \
  --agent coder --task task_... --status in_progress

node src/cli.mjs tasks --repo /absolute/path/to/project --agent coder
```

The same operations are available through MCP as `create_task`, `assign_task`,
`update_task_status`, and `list_tasks`.

If an integrity audit reports task-projection drift, rebuild the mutable
`tasks` table from immutable task events without changing event history,
messages, refs, or Git state:

```sh
node src/cli.mjs rebuild-tasks --repo /absolute/path/to/project
```

Configured agents can perform the same scoped recovery with the
`rebuild_task_projection` MCP tool.

## Local Dashboard

AgentGit includes a local, read-only operational dashboard for task state,
event activity, message delivery counts, and branch refs:

```sh
node src/cli.mjs serve --repo /absolute/path/to/project --port 3210
```

Open the printed `http://127.0.0.1:3210` URL. The dashboard is local only and
reads the existing AgentGit event store; it does not control the underlying
agent or alter its prompt.

## Checkpoints and Git

Record the current Git state without creating a commit:

```sh
node src/cli.mjs checkpoint \
  --repo /absolute/path/to/project \
  --agent coder --task task-login \
  --summary "Login endpoint implemented and tested"
```

To make the stage a normal Git commit and then record its AgentGit checkpoint:

```sh
node src/cli.mjs checkpoint \
  --repo /absolute/path/to/project \
  --agent coder --task task-login \
  --summary "feat: add login endpoint" --commit
```

A checkpoint saves branch, commit SHA, visible worktree status, and a
content-addressed binary diff in `.agentgit/objects/`. Events remain
append-only; refs and delivery state are the mutable projections.

## Development verification

```sh
npm test
npm run lint
python3 /Users/ming/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
npm pack --dry-run
```
