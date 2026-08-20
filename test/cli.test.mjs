import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-cli-')); }
function cli(args) {
  return execFileSync(process.execPath, [path.resolve('src/cli.mjs'), ...args], { encoding: 'utf8' });
}
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

test('CLI creates, assigns, and advances a task', () => {
  const repo = tempRepo();
  cli(['init', repo]);
  const created = JSON.parse(cli(['task-create', '--repo', repo, '--agent', 'planner', '--title', 'Build index', '--priority', 'high']));
  const taskId = created.task.id;
  const assigned = JSON.parse(cli(['task-assign', '--repo', repo, '--agent', 'planner', '--task', taskId, '--to', 'coder']));
  assert.equal(assigned.task.status, 'assigned');
  const started = JSON.parse(cli(['task-status', '--repo', repo, '--agent', 'coder', '--task', taskId, '--status', 'in_progress']));
  assert.equal(started.task.status, 'in_progress');
  assert.equal(JSON.parse(cli(['tasks', '--repo', repo, '--agent', 'coder']))[0].id, taskId);
});

test('CLI recognizes terminal --commit and --once flags', () => {
  const repo = tempRepo();
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'AgentGit Test']);
  git(repo, ['config', 'user.email', 'agentgit@example.test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'initial\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'initial']);
  cli(['init', repo]);
  fs.appendFileSync(path.join(repo, 'README.md'), 'changed\n');
  const checkpoint = JSON.parse(cli(['checkpoint', '--repo', repo, '--agent', 'coder', '--summary', 'Update readme', '--commit']));
  assert.equal(checkpoint.payload.committed, true);
  assert.equal(git(repo, ['log', '-1', '--format=%s']), 'Update readme');
  const sessions = path.join(repo, 'sessions');
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, 'rollout-demo.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } }) + '\n');
  const result = JSON.parse(cli(['watch-codex', '--repo', repo, '--dir', sessions, '--agent', 'coder', '--once']));
  assert.equal(result.imported, 1);
});
