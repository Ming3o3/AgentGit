---
name: agentgit
description: Use an already-configured AgentGit MCP server to coordinate coding-agent work through durable messages, task history, and Git checkpoints.
---

# AgentGit collaboration

At the beginning of a task, use `read_inbox` to inspect pending requests. Acknowledge a message only after you have acted on it or clearly recorded a blocker.

Use `send_message` for work that another agent needs to act on. Keep messages concise, include a task ID when one exists, and reference relevant checkpoint or event IDs.

Use `create_checkpoint` after a meaningful work stage. Set `commit` only when the changes are reviewed enough to become a normal Git commit. Before reporting a task complete, use `task_history` and make sure the final result and checkpoint are recorded.

Do not try to infer other agents' hidden reasoning. Use the observable event history, messages, tool outcomes, and Git checkpoint references.
