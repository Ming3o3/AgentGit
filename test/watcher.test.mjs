import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepository, EventStore } from '../src/store.mjs';
import { scanCodexRollouts, watchCodexRollouts } from '../src/watcher.mjs';

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-watch-')); }

test('scans nested Codex rollout files and imports only new records', () => {
  const root = tempRoot();
  const repo = path.join(root, 'repo');
  const sessions = path.join(root, 'sessions', '2026', '08', '19');
  fs.mkdirSync(sessions, { recursive: true });
  initRepository(repo);
  const rollout = path.join(sessions, 'rollout-demo.jsonl');
  const line = (message) => JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message } }) + '\n';
  fs.writeFileSync(rollout, line('first'));
  fs.writeFileSync(path.join(sessions, 'session_index.jsonl'), line('ignore me'));
  const store = new EventStore(repo);
  assert.deepEqual(scanCodexRollouts({ root: sessions, store, agentId: 'coder' }), { files: 1, imported: 1, skipped: 0 });
  assert.deepEqual(scanCodexRollouts({ root: sessions, store, agentId: 'coder' }), { files: 1, imported: 0, skipped: 0 });
  fs.appendFileSync(rollout, line('second'));
  assert.deepEqual(scanCodexRollouts({ root: sessions, store, agentId: 'coder' }), { files: 1, imported: 1, skipped: 0 });
  const history = store.list({ ref: 'session/codex/rollout-demo' });
  assert.deepEqual(history.map((event) => event.payload.text), ['first', 'second']);
  assert.equal(history[0].sessionId, 'rollout-demo');
  store.close();
});

test('ignores hidden directories and non-rollout JSONL files', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(root, '.hidden', 'rollout-hidden.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), '{}\n');
  assert.deepEqual(scanCodexRollouts({ root, store: { importJsonl() { throw new Error('should not import'); } }, agentId: 'coder' }), { files: 0, imported: 0, skipped: 0 });
});

test('keeps scanning when a rollout disappears during import', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'rollout-disappeared.jsonl'), '{}\n');
  const files = [];
  const error = Object.assign(new Error('rollout was rotated'), { code: 'ENOENT' });
  assert.deepEqual(scanCodexRollouts({
    root,
    store: { importJsonl() { throw error; } },
    agentId: 'coder',
    onFile(value) { files.push(value); },
  }), { files: 1, imported: 0, skipped: 0 });
  assert.equal(files.length, 1);
  assert.equal(files[0].error, error);
});

test('stops a long polling interval immediately when aborted', async () => {
  const root = tempRoot();
  const controller = new AbortController();
  let scans = 0;
  const started = Date.now();
  const watching = watchCodexRollouts({
    root,
    store: { importJsonl() { return { imported: 0, skipped: 0, offset: 0 }; } },
    agentId: 'coder',
    intervalMs: 5000,
    signal: controller.signal,
    onScan() {
      scans += 1;
      if (scans === 1) setTimeout(() => controller.abort(), 10);
    },
  });
  await watching;
  assert.equal(scans, 1);
  assert.ok(Date.now() - started < 1000);
});

test('does not scan when started with an already-aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  let scans = 0;
  await watchCodexRollouts({
    root: tempRoot(),
    store: { importJsonl() { throw new Error('scan should not import'); } },
    agentId: 'coder',
    signal: controller.signal,
    onScan() { scans += 1; },
  });
  assert.equal(scans, 0);
});
