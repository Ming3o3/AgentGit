import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { putObject } from './objects.mjs';

const WORKTREE_PATHS = ['.', ':(top,exclude).agentgit', ':(top,exclude).agentgit/**'];

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', path.resolve(repo), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trimEnd();
}

function tryGit(repo, args) {
  try { return git(repo, args); } catch { return null; }
}

function statusEntries(status) {
  if (!status) return [];
  return status.split('\0').filter(Boolean).map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
}

export function gitState(repo) {
  if (tryGit(repo, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error(`${path.resolve(repo)} is not a Git worktree`);
  }
  const head = tryGit(repo, ['rev-parse', 'HEAD']);
  const branch = tryGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const status = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...WORKTREE_PATHS]);
  const stagedDiff = git(repo, ['diff', '--cached', '--binary', '--no-ext-diff', '--', ...WORKTREE_PATHS]);
  const unstagedDiff = git(repo, ['diff', '--binary', '--no-ext-diff', '--', ...WORKTREE_PATHS]);
  return {
    root: git(repo, ['rev-parse', '--show-toplevel']),
    head,
    branch,
    status: statusEntries(status),
    stagedDiff,
    unstagedDiff,
  };
}

export function createCheckpoint({ repo, store, agentId, summary, taskId = null, sessionId = null, ref = null, commit = false }) {
  if (typeof summary !== 'string' || !summary.trim()) throw new Error('checkpoint summary is required');
  if (commit) {
    // initRepository adds .agentgit/ to the repository-local exclude file, so
    // a normal add cannot stage AgentGit's own SQLite database or objects.
    git(repo, ['add', '--all']);
    const before = tryGit(repo, ['rev-parse', 'HEAD']);
    try { git(repo, ['commit', '-m', summary]); } catch (error) {
      const after = tryGit(repo, ['rev-parse', 'HEAD']);
      if (after === before) throw new Error(`Git commit failed: ${error.stderr?.toString().trim() || error.message}`);
    }
  }
  const state = gitState(repo);
  const commitPatch = commit && state.head
    ? git(repo, ['show', '--format=', '--binary', '--no-ext-diff', state.head, '--', ...WORKTREE_PATHS])
    : '';
  const patch = commitPatch || [
      state.stagedDiff && `# staged\n${state.stagedDiff}`,
      state.unstagedDiff && `# unstaged\n${state.unstagedDiff}`,
    ].filter(Boolean).join('\n');
  const diff = putObject(repo, patch);
  return store.append({
    agentId,
    type: 'git.checkpoint',
    taskId,
    sessionId,
    ref,
    payload: {
      summary,
      git: {
        root: state.root,
        commit: state.head,
        branch: state.branch,
        status: state.status,
      },
      diff,
      committed: commit,
    },
  });
}
