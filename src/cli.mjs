#!/usr/bin/env node
import { initRepository, EventStore } from './store.mjs';
import fs from 'node:fs';
import { normalizeCodexRecord } from './adapters/codex.mjs';

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
  agentgit verify --repo <repo> <event-id>`);
  process.exit(1);
}

function args(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { result._.push(token); continue; }
    const key = token.slice(2).replaceAll('-', '_');
    result[key] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
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
  } else usage();
} catch (error) {
  console.error(`agentgit: ${error.message}`);
  process.exitCode = 1;
}
