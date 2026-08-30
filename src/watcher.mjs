import fs from 'node:fs';
import path from 'node:path';
import { normalizeCodexRecord } from './adapters/codex.mjs';

function rolloutFiles(root) {
  const result = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) result.push(entryPath);
    }
  }
  return result.sort();
}

export function scanCodexRollouts({ root, store, agentId, taskId = null, refPrefix = 'session/codex', onFile = () => {} }) {
  if (!root) throw new Error('Codex sessions directory is required');
  if (!agentId?.trim()) throw new Error('agentId is required');
  let imported = 0;
  let skipped = 0;
  let files = 0;
  for (const filePath of rolloutFiles(root)) {
    const sessionId = path.basename(filePath, '.jsonl');
    const result = store.importJsonl({
      filePath,
      sourceKey: `codex:${path.resolve(filePath)}`,
      agentId,
      taskId,
      sessionId,
      ref: `${refPrefix}/${sessionId}`,
      adapter: normalizeCodexRecord,
    });
    files += 1;
    imported += result.imported;
    skipped += result.skipped;
    onFile({ filePath, sessionId, ...result });
  }
  return { files, imported, skipped };
}

export async function watchCodexRollouts({ root, store, agentId, taskId = null, intervalMs = 1000, signal, onScan = () => {} }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 50) throw new Error('intervalMs must be an integer >= 50');
  let stopped = Boolean(signal?.aborted);
  const stop = () => { stopped = true; };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    while (!stopped) {
      onScan(scanCodexRollouts({ root, store, agentId, taskId }));
      if (stopped || !(await waitForInterval(intervalMs, signal))) break;
    }
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

function waitForInterval(intervalMs, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), intervalMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export { rolloutFiles };
