import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepository, EventStore } from '../src/store.mjs';
import { normalizeCodexRecord } from '../src/adapters/codex.mjs';

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-ingest-')); }

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
