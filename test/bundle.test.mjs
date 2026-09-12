import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { canonicalJson, sha256 } from '../src/canonical-json.mjs';
import {
  createEventBundle,
  exportEventBundle,
  importEventBundle,
  validateEventBundle,
} from '../src/bundle.mjs';
import { EventStore, schemaStatus } from '../src/store.mjs';

function tempRepo() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentgit-bundle-')); }

function rehashBundle(bundle) {
  const { bundleHash: _bundleHash, ...body } = bundle;
  return { ...body, bundleHash: sha256(body) };
}

test('exports and restores a complete portable event bundle', () => {
  const sourceRepo = tempRepo();
  const source = new EventStore(sourceRepo);
  const { task } = source.createTask({ createdBy: 'planner', title: 'Portable history', priority: 'high' });
  source.assignTask({ taskId: task.id, assignedBy: 'planner', assigneeId: 'coder' });
  const message = source.sendMessage({
    from: 'planner', to: ['coder'], text: 'x'.repeat(9000), taskId: task.id, ref: `task/${task.id}`,
  });
  source.acknowledge(message.id, 'coder');
  const rollout = path.join(tempRepo(), 'rollout.jsonl');
  fs.writeFileSync(rollout, '{"type":"observed","value":1}\n');
  source.importJsonl({
    filePath: rollout,
    agentId: 'coder',
    sourceKey: 'portable:rollout',
    adapter: (raw) => ({ type: 'source.observed', payload: { value: raw.value } }),
  });
  const sourceEvents = source.list({ limit: 100 });
  const sourceRefs = source.refs();
  const sourceIngest = source.exportSnapshot().ingestCursors;
  const bundleFile = path.join(tempRepo(), 'history.agentgit.json');
  const exported = exportEventBundle({ store: source, filePath: bundleFile });
  assert.equal(exported.events, 4);
  assert.equal(exported.objects, 1);
  assert.throws(() => exportEventBundle({ store: source, filePath: bundleFile }), /EEXIST/);
  source.close();

  const targetRepo = tempRepo();
  const target = new EventStore(targetRepo);
  const imported = importEventBundle({ store: target, filePath: bundleFile });
  assert.equal(imported.importedEvents, 4);
  assert.equal(imported.valid, true);
  assert.deepEqual(target.list({ limit: 100 }), sourceEvents);
  assert.deepEqual(target.refs(), sourceRefs);
  assert.equal(target.getTask(task.id).assigneeId, 'coder');
  assert.equal(target.delivery(message.id, 'coder').status, 'acknowledged');
  assert.deepEqual(target.exportSnapshot().ingestCursors, sourceIngest);
  assert.equal(target.exportSnapshot().sourceEvents.length, 1);
  assert.equal(target.verifyAll().valid, true);
  target.close();
});

test('re-import is idempotent and replaces mutable state only when requested', () => {
  const source = new EventStore(tempRepo());
  const message = source.sendMessage({ from: 'planner', to: ['coder'], text: 'Review this' });
  const bundleFile = path.join(tempRepo(), 'history.json');
  exportEventBundle({ store: source, filePath: bundleFile });
  source.close();

  const target = new EventStore(tempRepo());
  importEventBundle({ store: target, filePath: bundleFile });
  target.acknowledge(message.id, 'coder');
  const repeated = importEventBundle({ store: target, filePath: bundleFile });
  assert.equal(repeated.importedEvents, 0);
  assert.equal(repeated.skippedEvents, 1);
  assert.equal(repeated.replacedMutable, false);
  assert.equal(target.delivery(message.id, 'coder').status, 'acknowledged');

  const replaced = importEventBundle({ store: target, filePath: bundleFile, replaceMutable: true });
  assert.equal(replaced.replacedMutable, true);
  assert.equal(target.delivery(message.id, 'coder').status, 'pending');
  assert.equal(target.verifyAll().valid, true);
  target.close();
});

test('rejects tampered bundles and destinations with different histories', () => {
  const source = new EventStore(tempRepo());
  source.append({ agentId: 'planner', type: 'note.recorded', payload: { text: 'original' } });
  const bundle = createEventBundle(source);
  source.close();

  const tampered = structuredClone(bundle);
  tampered.events[0].payload.text = 'tampered';
  assert.throws(() => validateEventBundle(rehashBundle(tampered)), /event hash mismatch/);

  const bundleFile = path.join(tempRepo(), 'history.json');
  fs.writeFileSync(bundleFile, `${JSON.stringify(bundle)}\n`);
  const target = new EventStore(tempRepo());
  const local = target.append({ agentId: 'local', type: 'note.recorded', payload: {} });
  assert.throws(() => importEventBundle({ store: target, filePath: bundleFile }), /different event history/);
  assert.equal(target.list({ limit: 10 }).length, 1);
  assert.equal(target.get(local.id).id, local.id);
  target.close();
});

test('reports schema migrations without modifying the database', () => {
  const repo = tempRepo();
  const directory = path.join(repo, '.agentgit');
  fs.mkdirSync(directory, { recursive: true });
  const databasePath = path.join(directory, 'events.db');
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata(key, value) VALUES ('schema_version', '1');
  `);
  database.close();

  const status = schemaStatus(repo);
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.needsMigration, true);
  assert.deepEqual(status.pendingMigrations.map((migration) => migration.version), [2, 3]);
  const reopened = new Database(databasePath, { readonly: true });
  assert.equal(reopened.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value, '1');
  reopened.close();

  assert.equal(schemaStatus(tempRepo()).initialized, false);
  assert.equal(canonicalJson(status.pendingMigrations).includes('projections-and-ingest'), true);
});
