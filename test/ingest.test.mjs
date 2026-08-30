import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { initRepository, EventStore } from '../src/store.mjs';
import { normalizeCodexRecord } from '../src/adapters/codex.mjs';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-ingest-')); }

function importFromProcess({ worker, repo, rollout, sourceKey }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, repo, rollout, sourceKey], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`worker failed (${code}): ${stderr}`));
    });
  });
}

test('normalizes Codex messages and tool calls', () => {
  assert.deepEqual(normalizeCodexRecord({ type: 'event_msg', payload: { type: 'agent_message', message: 'done' } }), {
    type: 'agent.message', payload: { text: 'done' }, adapter: 'codex',
  });
  assert.equal(normalizeCodexRecord({ type: 'response_item', payload: { type: 'reasoning', content: [{ text: 'hidden' }] } }), null);
  assert.equal(normalizeCodexRecord({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }).type, 'tool.called');
});

test('imports complete JSONL lines and resumes from a cursor', () => {
  const root = tempDir();
  const repo = path.join(root, 'repo');
  const rollout = path.join(root, 'rollout.jsonl');
  initRepository(repo);
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'start' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', content: [{ text: 'skip' }] } }),
  ].join('\n') + '\npartial');
  const store = new EventStore(repo);
  assert.deepEqual(store.importJsonl({ filePath: rollout, agentId: 'coder', ref: 'session/coder', adapter: normalizeCodexRecord }), { imported: 2, skipped: 1, offset: Buffer.byteLength(fs.readFileSync(rollout).toString().split('partial')[0]) });
  assert.equal(store.list({ ref: 'session/coder' }).length, 2);
  assert.deepEqual(store.importJsonl({ filePath: rollout, agentId: 'coder', ref: 'session/coder', adapter: normalizeCodexRecord }), { imported: 0, skipped: 0, offset: Buffer.byteLength(fs.readFileSync(rollout).toString().split('partial')[0]) });
  fs.appendFileSync(rollout, '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'done' } }) + '\n');
  assert.equal(store.importJsonl({ filePath: rollout, agentId: 'coder', ref: 'session/coder', adapter: normalizeCodexRecord }).imported, 1);
  assert.equal(store.list({ ref: 'session/coder' }).length, 3);
  store.close();
});

test('restarts a source when a rollout file is truncated', () => {
  const root = tempDir();
  const repo = path.join(root, 'repo');
  const rollout = path.join(root, 'rollout.jsonl');
  initRepository(repo);
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old-1' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old-2' } }),
  ].join('\n') + '\n');
  const store = new EventStore(repo);
  const first = store.importJsonl({ filePath: rollout, agentId: 'coder', sourceKey: 'codex:test', adapter: normalizeCodexRecord });
  assert.equal(first.imported, 2);
  fs.writeFileSync(rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new-1' } }) + '\n');
  const second = store.importJsonl({ filePath: rollout, agentId: 'coder', sourceKey: 'codex:test', adapter: normalizeCodexRecord });
  assert.deepEqual(second, { imported: 1, skipped: 0, offset: fs.statSync(rollout).size });
  assert.deepEqual(store.list({ limit: 10 }).map((event) => event.payload.text), ['old-1', 'old-2', 'new-1']);
  assert.equal(store.verifyAll().valid, true);
  store.close();
});

test('restarts a source when valid lines move backward despite a larger file', () => {
  const root = tempDir();
  const repo = path.join(root, 'repo');
  const rollout = path.join(root, 'rollout.jsonl');
  initRepository(repo);
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old-1' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old-2' } }),
  ].join('\n') + '\n');
  const store = new EventStore(repo);
  const first = store.importJsonl({ filePath: rollout, agentId: 'coder', sourceKey: 'codex:larger-rewrite', adapter: normalizeCodexRecord });
  assert.equal(first.imported, 2);
  fs.writeFileSync(rollout, `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new-1' } })}\n${'partial-data-that-is-longer-than-the-old-tail'.repeat(10)}`);
  const second = store.importJsonl({ filePath: rollout, agentId: 'coder', sourceKey: 'codex:larger-rewrite', adapter: normalizeCodexRecord });
  assert.equal(second.imported, 1);
  assert.deepEqual(store.list({ limit: 10 }).map((event) => event.payload.text), ['old-1', 'old-2', 'new-1']);
  assert.equal(store.verifyAll().valid, true);
  store.close();
});

test('restarts a source when a rollout prefix is rewritten at the same length', () => {
  const root = tempDir();
  const repo = path.join(root, 'repo');
  const rollout = path.join(root, 'rollout.jsonl');
  initRepository(repo);
  const line = (message) => JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message } }) + '\n';
  fs.writeFileSync(rollout, line('old-1') + line('old-2'));
  const store = new EventStore(repo);
  assert.equal(store.importJsonl({ filePath: rollout, agentId: 'coder', sourceKey: 'codex:rewrite', adapter: normalizeCodexRecord }).imported, 2);
  fs.writeFileSync(rollout, line('new-1') + line('new-2'));
  assert.equal(store.importJsonl({ filePath: rollout, agentId: 'coder', sourceKey: 'codex:rewrite', adapter: normalizeCodexRecord }).imported, 2);
  assert.deepEqual(store.list({ limit: 10 }).map((event) => event.payload.text), ['old-1', 'old-2', 'new-1', 'new-2']);
  assert.equal(store.verifyAll().valid, true);
  store.close();
});

test('serializes concurrent imports of one rollout cursor', async () => {
  const root = tempDir();
  const repo = path.join(root, 'repo');
  const rollout = path.join(root, 'rollout.jsonl');
  const sourceKey = 'codex:concurrent';
  initRepository(repo);
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'one' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'two' } }),
  ].join('\n') + '\n');
  const worker = path.join(repo, 'import-worker.mjs');
  const storeUrl = pathToFileURL(path.resolve('src/store.mjs')).href;
  const adapterUrl = pathToFileURL(path.resolve('src/adapters/codex.mjs')).href;
  fs.writeFileSync(worker, `import { EventStore } from ${JSON.stringify(storeUrl)};
import { normalizeCodexRecord } from ${JSON.stringify(adapterUrl)};
const store = new EventStore(process.argv[2]);
const result = store.importJsonl({ filePath: process.argv[3], sourceKey: process.argv[4], agentId: 'coder', adapter: normalizeCodexRecord });
store.close();
process.stdout.write(JSON.stringify(result));
`);
  const results = await Promise.all(Array.from({ length: 8 }, () => importFromProcess({ worker, repo, rollout, sourceKey })));
  assert.equal(results.reduce((total, result) => total + result.imported, 0), 2);
  assert.equal(results.filter((result) => result.imported === 2).length, 1);
  assert.equal(results.filter((result) => result.imported === 0).length, 7);
  const store = new EventStore(repo);
  assert.deepEqual(store.list({ limit: 10 }).map((event) => event.payload.text), ['one', 'two']);
  assert.equal(store.verifyAll().valid, true);
  store.close();
});
