#!/usr/bin/env node
import { initRepository, EventStore } from './store.mjs';
import fs from 'node:fs';
import { normalizeCodexRecord } from './adapters/codex.mjs';
import { createCheckpoint } from './git.mjs';
import { scanCodexRollouts, watchCodexRollouts } from './watcher.mjs';
import { codexMcpConfig } from './codex-config.mjs';
import { startDashboard } from './dashboard-server.mjs';

function usage() {
  console.error(`Usage:
  agentgit init [repo]
  agentgit emit --repo <repo> --agent <id> --type <type> --payload <json> [--ref <name>]
  agentgit log --repo <repo> [--ref <name>] [--task <id>] [--agent <id>] [--type <type>]
  agentgit show --repo <repo> <event-id>
  agentgit import-codex --repo <repo> --file <rollout.jsonl> --agent <id> [--task <id>] [--session <id>] [--ref <name>]
  agentgit send --repo <repo> --from <id> --to <id[,id...]> --text <message> [--subject <text>]
  agentgit inbox --repo <repo> --agent <id> [--status pending|delivered|acknowledged]
  agentgit ack --repo <repo> --agent <id> --event <event-id>
  agentgit checkpoint --repo <repo> --agent <id> --summary <text> [--task <id>] [--ref <name>] [--commit]
  agentgit watch-codex --repo <repo> --dir <codex-sessions-dir> --agent <id> [--task <id>] [--interval <ms>] [--once]
  agentgit codex-config --repo <repo> --agent <id>
  agentgit task-create --repo <repo> --agent <id> --title <text> [--description <text>] [--priority low|normal|high|urgent]
  agentgit task-assign --repo <repo> --agent <id> --task <id> --to <agent-id> [--note <text>]
  agentgit task-status --repo <repo> --agent <id> --task <id> --status <status> [--summary <text>]
  agentgit tasks --repo <repo> [--agent <id>] [--status <status>]
  agentgit serve --repo <repo> [--host <host>] [--port <port>]
  agentgit verify --repo <repo> <event-id>`);
  process.exit(1);
}

function args(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { result._.push(token); continue; }
    const key = token.slice(2).replaceAll('-', '_');
    result[key] = i + 1 >= argv.length || argv[i + 1].startsWith('--') ? true : argv[++i];
  }
  return result;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

const command = process.argv[2];
const options = args(process.argv.slice(3));

try {
  if (command === 'init') {
    print(initRepository(options._[0] ?? '.'));
  } else if (command === 'emit') {
    if (!options.repo || !options.agent || !options.type || !options.payload) usage();
    const store = new EventStore(options.repo);
    try {
      print(store.append({
        agentId: options.agent,
        type: options.type,
        payload: JSON.parse(options.payload),
        taskId: options.task,
        sessionId: options.session,
        causationId: options.causation,
        ref: options.ref,
      }));
    } finally { store.close(); }
  } else if (command === 'log') {
    if (!options.repo) usage();
    const store = new EventStore(options.repo);
    try { print(store.list({ ref: options.ref, taskId: options.task, agentId: options.agent, type: options.type, limit: Number(options.limit ?? 100) })); }
    finally { store.close(); }
  } else if (command === 'show') {
    if (!options.repo || !options._[0]) usage();
    const store = new EventStore(options.repo);
    try { print(store.get(options._[0])); }
    finally { store.close(); }
  } else if (command === 'verify') {
    if (!options.repo || !options._[0]) usage();
    const store = new EventStore(options.repo);
    try {
      const result = store.verify(options._[0]);
      print(result);
      if (!result.valid) process.exitCode = 1;
    } finally { store.close(); }
  } else if (command === 'import-codex') {
    if (!options.repo || !options.file || !options.agent) usage();
    if (!fs.existsSync(options.file)) throw new Error(`file does not exist: ${options.file}`);
    const store = new EventStore(options.repo);
    try {
      print(store.importJsonl({ filePath: options.file, agentId: options.agent, taskId: options.task, sessionId: options.session, ref: options.ref, adapter: normalizeCodexRecord }));
    } finally { store.close(); }
  } else if (command === 'send') {
    if (!options.repo || !options.from || !options.to || !options.text) usage();
    const store = new EventStore(options.repo);
    try {
      print(store.sendMessage({ from: options.from, to: String(options.to).split(','), text: options.text, subject: options.subject ?? null, taskId: options.task, sessionId: options.session, ref: options.ref }));
    } finally { store.close(); }
  } else if (command === 'inbox') {
    if (!options.repo || !options.agent) usage();
    const store = new EventStore(options.repo);
    try { print(store.inbox({ agentId: options.agent, status: options.status ?? null, limit: Number(options.limit ?? 100) })); }
    finally { store.close(); }
  } else if (command === 'ack') {
    if (!options.repo || !options.agent || !options.event) usage();
    const store = new EventStore(options.repo);
    try { print(store.acknowledge(options.event, options.agent)); }
    finally { store.close(); }
  } else if (command === 'checkpoint') {
    if (!options.repo || !options.agent || !options.summary) usage();
    const store = new EventStore(options.repo);
    try {
      print(createCheckpoint({ repo: options.repo, store, agentId: options.agent, summary: options.summary, taskId: options.task, sessionId: options.session, ref: options.ref, commit: options.commit === true }));
    } finally { store.close(); }
  } else if (command === 'watch-codex') {
    if (!options.repo || !options.dir || !options.agent) usage();
    const store = new EventStore(options.repo);
    const intervalMs = Number(options.interval ?? 1000);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      if (options.once === true) {
        print(scanCodexRollouts({ root: options.dir, store, agentId: options.agent, taskId: options.task }));
      } else {
        console.error(`agentgit: watching ${options.dir}`);
        await watchCodexRollouts({ root: options.dir, store, agentId: options.agent, taskId: options.task, intervalMs, signal: controller.signal, onScan: (summary) => {
          if (summary.imported || summary.skipped) console.error(`agentgit: imported=${summary.imported} skipped=${summary.skipped}`);
        } });
      }
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      store.close();
    }
  } else if (command === 'codex-config') {
    if (!options.repo || !options.agent) usage();
    process.stdout.write(codexMcpConfig({ repo: options.repo, agentId: options.agent }));
  } else if (command === 'task-create') {
    if (!options.repo || !options.agent || !options.title) usage();
    const store = new EventStore(options.repo);
    try { print(store.createTask({ createdBy: options.agent, title: options.title, description: options.description ?? '', priority: options.priority ?? 'normal', sessionId: options.session ?? null })); }
    finally { store.close(); }
  } else if (command === 'task-assign') {
    if (!options.repo || !options.agent || !options.task || !options.to) usage();
    const store = new EventStore(options.repo);
    try { print(store.assignTask({ taskId: options.task, assignedBy: options.agent, assigneeId: options.to, note: options.note ?? null })); }
    finally { store.close(); }
  } else if (command === 'task-status') {
    if (!options.repo || !options.agent || !options.task || !options.status) usage();
    const store = new EventStore(options.repo);
    try { print(store.updateTaskStatus({ taskId: options.task, updatedBy: options.agent, status: options.status, summary: options.summary ?? null })); }
    finally { store.close(); }
  } else if (command === 'tasks') {
    if (!options.repo) usage();
    const store = new EventStore(options.repo);
    try { print(store.listTasks({ assigneeId: options.agent ?? null, status: options.status ?? null, limit: Number(options.limit ?? 100) })); }
    finally { store.close(); }
  } else if (command === 'serve') {
    if (!options.repo) usage();
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const dashboard = await startDashboard({ repo: options.repo, host: options.host ?? '127.0.0.1', port: Number(options.port ?? 3210) });
    console.log(dashboard.url);
    try {
      await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
    } finally {
      await new Promise((resolve) => dashboard.server.close(resolve));
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } else usage();
} catch (error) {
  console.error(`agentgit: ${error.message}`);
  process.exitCode = 1;
}
