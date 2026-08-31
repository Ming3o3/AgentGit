import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepository, EventStore } from '../src/store.mjs';
import { objectPath, readObject } from '../src/objects.mjs';
import { redactText } from '../src/payload.mjs';

function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-payload-')); }

test('redacts common credential formats before persistence', () => {
  const text = 'api_key=super-secret-value password: "another-secret" Authorization: Bearer abcdefghijklmnop';
  const redacted = redactText(text);
  assert.equal(redacted.includes('super-secret-value'), false);
  assert.equal(redacted.includes('another-secret'), false);
  assert.equal(redacted.includes('abcdefghijklmnop'), false);
  assert.match(redacted, /\[REDACTED\]/);
});

test('redacts credential keys inside JSON-encoded text', () => {
  const redacted = redactText('{"apiKey":"json-secret","accessToken":"json-token"}');
  assert.equal(redacted, '{"apiKey":"[REDACTED]","accessToken":"[REDACTED]"}');
});

test('fully redacts quoted credentials and authorization headers', () => {
  assert.equal(redactText('password="secret with spaces"'), 'password="[REDACTED]"');
  assert.equal(redactText("client_secret: 'another secret'"), "client_secret: '[REDACTED]'");
  assert.equal(redactText('Authorization: Basic dXNlcjpwYXNzd29yZA=='), 'Authorization: [REDACTED]');
  assert.equal(redactText('Authorization: Bearer abcdefghijklmnop'), 'Authorization: [REDACTED]');
  assert.equal(redactText('token=abc123, next=value'), 'token=[REDACTED], next=value');
});

test('redacts credential-shaped keys in nested structured payloads', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const event = store.append({
    agentId: 'coder',
    type: 'tool.called',
    payload: {
      config: {
        apiKey: 'sk-structured-secret',
        password: 'nested-password',
        Authorization: 'Bearer structured-token',
      },
      items: [{ access_token: 'nested-access-token' }],
    },
  });
  assert.deepEqual(event.payload, {
    config: { apiKey: '[REDACTED]', password: '[REDACTED]', Authorization: '[REDACTED]' },
    items: [{ access_token: '[REDACTED]' }],
  });
  assert.equal(store.verifyAll().valid, true);
  store.close();
});

test('externalizes large payload text to a content-addressed object', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const event = store.append({ agentId: 'coder', type: 'tool.completed', payload: { output: 'x'.repeat(9000) } });
  const output = event.payload.output;
  assert.match(output.objectRef, /^sha256:/);
  assert.equal(output.bytes, 9000);
  assert.equal(readObject(repo, output.objectRef).toString(), 'x'.repeat(9000));
  assert.equal(store.get(event.id).payload.output.objectRef, output.objectRef);
  store.close();
});

test('normalizes runtime-only payload values before hashing', () => {
  const repo = tempRepo();
  initRepository(repo);
  const store = new EventStore(repo);
  const circular = { name: 'runtime' };
  circular.self = circular;
  let getterReads = 0;
  const withGetter = {};
  Object.defineProperty(withGetter, 'dangerous', { enumerable: true, get() { getterReads += 1; return 'secret'; } });
  const event = store.append({
    agentId: 'harness',
    type: 'tool.runtime_result',
    payload: {
      circular,
      count: 42n,
      omitted: undefined,
      nonFinite: Number.POSITIVE_INFINITY,
      negativeZero: -0,
      when: new Date('2026-08-31T00:00:00.000Z'),
      bytes: Buffer.from('hello'),
      error: Object.assign(new Error('failed'), { code: 'E_TEST' }),
      map: new Map([['key', 'value']]),
      set: new Set(['item']),
      withGetter,
      callback: function runtimeCallback() {},
    },
  });
  assert.deepEqual(event.payload, {
    circular: { name: 'runtime', self: '[Circular]' },
    count: '42n',
    omitted: null,
    nonFinite: null,
    negativeZero: 0,
    when: '2026-08-31T00:00:00.000Z',
    bytes: { encoding: 'base64', data: 'aGVsbG8=', bytes: 5 },
    error: { name: 'Error', message: 'failed', code: 'E_TEST' },
    map: [['key', 'value']],
    set: ['item'],
    withGetter: { dangerous: '[Accessor]' },
    callback: '[Function: runtimeCallback]',
  });
  assert.equal(getterReads, 0);
  assert.equal(store.verifyAll().valid, true);
  store.close();
});

test('rejects malformed object references before touching the filesystem', () => {
  const repo = tempRepo();
  assert.throws(() => objectPath(repo, '../outside'), /invalid object hash/);
  assert.throws(() => readObject(repo, 'sha256:../outside'), /invalid object hash/);
  assert.throws(() => readObject(repo, 'not-a-reference'), /invalid object hash/);
});
