# AgentGit

AgentGit is a local-first collaboration layer for existing coding agents. The
first version stores immutable, hash-addressed events in SQLite. It does not
replace an agent, Git, or the agent's native session files.

## Quick start

```sh
npm install
node src/cli.mjs init ./demo
node src/cli.mjs emit --repo ./demo --agent planner --type task.created \
  --payload '{"title":"Implement login"}' --ref task/login
node src/cli.mjs emit --repo ./demo --agent coder --type message.sent \
  --payload '{"text":"I started the implementation"}' --ref task/login
node src/cli.mjs log --repo ./demo --ref task/login
```

An event is append-only. A ref is a mutable pointer to the latest event, which
provides Git-like branch heads without rewriting history.
