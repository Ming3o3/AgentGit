# End-to-end local collaboration

This example routes one task from a planner to a coder, records the response and
Git evidence, and lets a reviewer verify the immutable history. All participants
share one target project directory.

Set the project path used throughout the example:

```sh
PROJECT=/absolute/path/to/project
agentgit init "$PROJECT"
```

## 1. Create and assign work

```sh
agentgit task-create --repo "$PROJECT" --agent planner \
  --title "Add login endpoint" \
  --description "Implement POST /login and its tests" \
  --priority high
```

The result contains both the immutable creation event and current task:

```json
{
  "event": { "id": "evt_create", "type": "task.created" },
  "task": { "id": "task_example", "status": "open" }
}
```

Use the returned task ID in later commands:

```sh
TASK=task_example
agentgit task-assign --repo "$PROJECT" --agent planner \
  --task "$TASK" --to coder --note "Use the existing auth service"

agentgit send --repo "$PROJECT" --from planner --to coder \
  --task "$TASK" --subject "Login implementation" \
  --text "Implement the task and send the checkpoint event for review."
```

Save the returned message event ID as `MESSAGE` if the response should have an
explicit causal link.

## 2. Receive and perform work

The coder receives the message. This changes only its delivery state from
`pending` to `delivered`:

```sh
agentgit inbox --repo "$PROJECT" --agent coder --status pending
agentgit task-status --repo "$PROJECT" --agent coder \
  --task "$TASK" --status in_progress
```

After implementing and testing in the target Git repository, create a normal
Git commit and its AgentGit checkpoint in one explicit operation:

```sh
agentgit checkpoint --repo "$PROJECT" --agent coder --task "$TASK" \
  --summary "feat: add tested login endpoint" --ref "task/$TASK" --commit
```

The checkpoint event records the resulting commit SHA, branch, status, and a
content-addressed diff. Save its event ID as `CHECKPOINT`.

Complete the task and reply to the original request:

```sh
agentgit task-status --repo "$PROJECT" --agent coder \
  --task "$TASK" --status completed --summary "Implementation and tests pass"

agentgit send --repo "$PROJECT" --from coder --to planner,reviewer \
  --task "$TASK" --causation "$MESSAGE" \
  --subject "Login ready" --text "Review checkpoint $CHECKPOINT."

agentgit ack --repo "$PROJECT" --agent coder --event "$MESSAGE"
```

Acknowledgement means the recipient acted on the message; reading it alone does
not acknowledge the work.

## 3. Review the evidence

```sh
agentgit tasks --repo "$PROJECT" --status completed
agentgit log --repo "$PROJECT" --task "$TASK"
agentgit show --repo "$PROJECT" "$CHECKPOINT"
agentgit verify --repo "$PROJECT" --all
```

The task log is ordered by AgentGit's local monotonic sequence, even if events
share a timestamp. A successful full audit has this general shape:

```json
{
  "valid": true,
  "checked": {
    "events": 7,
    "eventOrder": 7,
    "refs": 1,
    "deliveries": 3,
    "objects": 1,
    "sourceEvents": 0,
    "ingestCursors": 0,
    "tasks": 1
  },
  "issues": []
}
```

Counts depend on the exact messages, refs, and externalized payloads created by
the run. `valid: true` and an empty `issues` array are the stable assertions.

## 4. Observe without mutating

```sh
agentgit inbox --repo "$PROJECT" --agent reviewer --peek
agentgit serve --repo "$PROJECT" --port 3210
```

Open `http://127.0.0.1:3210`. The reviewer can inspect tasks, recent activity,
and ref heads without changing task, message, event, or Git state. Note that
`--peek` is required for a non-mutating CLI inbox read.

## 5. Close the recovery loop

```sh
agentgit backup --repo "$PROJECT" --file /secure/path/login-history.json
agentgit schema-status --repo "$PROJECT"
```

Test the backup in a disposable empty project before relying on it:

```sh
RESTORE_PROJECT=/absolute/path/to/empty-restore-project
agentgit import --repo "$RESTORE_PROJECT" --file /secure/path/login-history.json
agentgit verify --repo "$RESTORE_PROJECT" --all
agentgit log --repo "$RESTORE_PROJECT" --task "$TASK"
```

The restored event IDs and hashes match the source. Git source and commits must
be restored separately from the Git repository or its own backup.
