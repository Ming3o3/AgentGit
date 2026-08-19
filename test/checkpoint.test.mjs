import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initRepository, EventStore } from '../src/store.mjs';
import { createCheckpoint } from '../src/git.mjs';
import { readObject } from '../src/objects.mjs';

function shell(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function gitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-checkpoint-'));
  shell(repo, ['init', '-b', 'main']);
  shell(repo, ['config', 'user.name', 'AgentGit Test']);
  shell(repo, ['config', 'user.email', 'agentgit@example.test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  shell(repo, ['add', 'README.md']);
  shell(repo, ['commit', '-m', 'initial']);
  return repo;
}

test('records a Git checkpoint and stores the dirty diff by content hash', () => {
  const repo = gitRepo();
  initRepository(repo);
  fs.appendFileSync(path.join(repo, 'README.md'), 'changed\n');
  const store = new EventStore(repo);
  const checkpoint = createCheckpoint({ repo, store, agentId: 'coder', summary: 'Changed README', taskId: 'task-1' });
  assert.equal(checkpoint.type, 'git.checkpoint');
  assert.equal(checkpoint.payload.committed, false);
  assert.equal(checkpoint.payload.git.status[0].path, 'README.md');
  assert.match(readObject(repo, checkpoint.payload.diff.hash).toString(), /\+changed/);
  store.close();
});

test('can commit an explicit checkpoint and records the resulting commit', () => {
  const repo = gitRepo();
  initRepository(repo);
  fs.appendFileSync(path.join(repo, 'README.md'), 'committed\n');
  const store = new EventStore(repo);
  const checkpoint = createCheckpoint({ repo, store, agentId: 'coder', summary: 'Add README detail', commit: true });
  assert.equal(checkpoint.payload.committed, true);
  assert.equal(checkpoint.payload.git.status.length, 0);
  assert.equal(checkpoint.payload.git.commit, shell(repo, ['rev-parse', 'HEAD']));
  assert.equal(shell(repo, ['log', '-1', '--format=%s']), 'Add README detail');
  assert.match(readObject(repo, checkpoint.payload.diff.hash).toString(), /\+committed/);
  assert.equal(shell(repo, ['ls-tree', '-r', '--name-only', 'HEAD']).includes('.agentgit/events.db'), false);
  assert.equal(shell(repo, ['status', '--short']), '');
  store.close();
});
