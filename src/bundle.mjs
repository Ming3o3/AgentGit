import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from './canonical-json.mjs';
import { putObject, readObject } from './objects.mjs';
import { SUPPORTED_SCHEMA_VERSION } from './store.mjs';

export const EVENT_BUNDLE_FORMAT = 'agentgit.event-bundle';
export const EVENT_BUNDLE_VERSION = 1;

const DELIVERY_STATUSES = new Set(['pending', 'delivered', 'acknowledged']);
const TOP_LEVEL_KEYS = [
  'bundleHash', 'deliveries', 'events', 'exportedAt', 'format', 'ingestCursors',
  'objects', 'refs', 'schemaVersion', 'sourceEvents', 'version',
].sort();

function validTimestamp(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function requireArray(value, name) {
  if (!Array.isArray(value)) throw new Error(`invalid event bundle: ${name} must be an array`);
  return value;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid event bundle: ${name} must be an object`);
  }
  return value;
}

function collectObjectReferences(value, references = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectReferences(item, references);
  } else if (value && typeof value === 'object') {
    let reference = null;
    if (typeof value.objectRef === 'string') reference = value.objectRef;
    else if (typeof value.hash === 'string' && Object.hasOwn(value, 'bytes')) reference = value.hash;
    if (reference !== null) {
      const sizes = references.get(reference) ?? [];
      sizes.push(value.bytes);
      references.set(reference, sizes);
    }
    for (const item of Object.values(value)) collectObjectReferences(item, references);
  }
  return references;
}

function eventHashInput(event) {
  return {
    id: event.id,
    task_id: event.taskId ?? null,
    session_id: event.sessionId ?? null,
    agent_id: event.agentId,
    type: event.type,
    parents: event.parents,
    causation_id: event.causationId ?? null,
    payload: event.payload,
    source: event.source ?? null,
    created_at: event.createdAt,
  };
}

function bundleBody(bundle) {
  const { bundleHash: _bundleHash, ...body } = bundle;
  return body;
}

function validateEvents(events) {
  const byId = new Map();
  const hashes = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = requireObject(events[index], `events[${index}]`);
    if (event.sequence !== index + 1) throw new Error('invalid event bundle: event sequences must be contiguous from 1');
    if (typeof event.id !== 'string' || !event.id) throw new Error(`invalid event bundle: events[${index}].id`);
    if (byId.has(event.id)) throw new Error(`invalid event bundle: duplicate event ID ${event.id}`);
    if (typeof event.agentId !== 'string' || !event.agentId.trim()) throw new Error(`invalid event bundle: event agent ${event.id}`);
    if (typeof event.type !== 'string' || !event.type.trim()) throw new Error(`invalid event bundle: event type ${event.id}`);
    if (!Array.isArray(event.parents) || event.parents.some((parent) => typeof parent !== 'string' || !parent)) {
      throw new Error(`invalid event bundle: event parents ${event.id}`);
    }
    requireObject(event.payload, `event payload ${event.id}`);
    if (event.source !== null && event.source !== undefined) requireObject(event.source, `event source ${event.id}`);
    if (!validTimestamp(event.createdAt)) throw new Error(`invalid event bundle: event timestamp ${event.id}`);
    if (!/^[a-f0-9]{64}$/u.test(event.contentHash)) throw new Error(`invalid event bundle: event hash ${event.id}`);
    const actualHash = sha256(eventHashInput(event));
    if (actualHash !== event.contentHash) throw new Error(`invalid event bundle: event hash mismatch ${event.id}`);
    if (hashes.has(event.contentHash)) throw new Error(`invalid event bundle: duplicate event hash ${event.contentHash}`);
    hashes.add(event.contentHash);
    byId.set(event.id, event);
  }
  for (const event of events) {
    for (const parent of event.parents) {
      const parentEvent = byId.get(parent);
      if (!parentEvent) throw new Error(`invalid event bundle: missing parent ${parent}`);
      if (parentEvent.sequence >= event.sequence) throw new Error(`invalid event bundle: parent order ${event.id}`);
    }
    if (event.causationId !== null && event.causationId !== undefined) {
      const cause = byId.get(event.causationId);
      if (!cause) throw new Error(`invalid event bundle: missing causation ${event.causationId}`);
      if (cause.sequence >= event.sequence) throw new Error(`invalid event bundle: causation order ${event.id}`);
    }
  }
  return byId;
}

function validateRefs(refs, events) {
  const names = new Set();
  for (const ref of refs) {
    requireObject(ref, 'ref');
    if (typeof ref.name !== 'string' || !ref.name.trim() || names.has(ref.name)) {
      throw new Error(`invalid event bundle: ref name ${String(ref.name)}`);
    }
    if (ref.eventId !== null && !events.has(ref.eventId)) throw new Error(`invalid event bundle: ref event ${ref.name}`);
    if (!validTimestamp(ref.updatedAt)) throw new Error(`invalid event bundle: ref timestamp ${ref.name}`);
    names.add(ref.name);
  }
}

function validateDeliveries(deliveries, events) {
  const keys = new Set();
  const recipients = new Map();
  for (const delivery of deliveries) {
    requireObject(delivery, 'delivery');
    const event = events.get(delivery.eventId);
    if (!event || event.type !== 'message.sent') throw new Error(`invalid event bundle: delivery event ${delivery.eventId}`);
    if (typeof delivery.recipientId !== 'string' || !delivery.recipientId.trim()) {
      throw new Error(`invalid event bundle: delivery recipient ${delivery.eventId}`);
    }
    const key = `${delivery.eventId}\u0000${delivery.recipientId}`;
    if (keys.has(key)) throw new Error(`invalid event bundle: duplicate delivery ${delivery.eventId}`);
    if (!DELIVERY_STATUSES.has(delivery.status)) throw new Error(`invalid event bundle: delivery status ${delivery.eventId}`);
    if (delivery.createdAt !== event.createdAt || !validTimestamp(delivery.createdAt)) {
      throw new Error(`invalid event bundle: delivery created timestamp ${delivery.eventId}`);
    }
    const deliveredValid = delivery.deliveredAt === null || validTimestamp(delivery.deliveredAt);
    const acknowledgedValid = delivery.acknowledgedAt === null || validTimestamp(delivery.acknowledgedAt);
    if (!deliveredValid || !acknowledgedValid) throw new Error(`invalid event bundle: delivery timestamp ${delivery.eventId}`);
    const stateValid = (delivery.status === 'pending' && delivery.deliveredAt === null && delivery.acknowledgedAt === null)
      || (delivery.status === 'delivered' && delivery.deliveredAt !== null && delivery.acknowledgedAt === null)
      || (delivery.status === 'acknowledged' && delivery.deliveredAt !== null && delivery.acknowledgedAt !== null);
    if (!stateValid || (delivery.deliveredAt && delivery.createdAt > delivery.deliveredAt)
      || (delivery.acknowledgedAt && delivery.deliveredAt > delivery.acknowledgedAt)) {
      throw new Error(`invalid event bundle: delivery chronology ${delivery.eventId}`);
    }
    keys.add(key);
    const eventRecipients = recipients.get(delivery.eventId) ?? [];
    eventRecipients.push(delivery.recipientId);
    recipients.set(delivery.eventId, eventRecipients);
  }
  for (const event of events.values()) {
    if (event.type !== 'message.sent') continue;
    const declared = event.payload.to;
    if (!Array.isArray(declared)) throw new Error(`invalid event bundle: message recipients ${event.id}`);
    const expected = [...new Set(declared)].sort();
    const actual = [...new Set(recipients.get(event.id) ?? [])].sort();
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      throw new Error(`invalid event bundle: delivery recipients mismatch ${event.id}`);
    }
  }
}

function validateIngest(sourceEvents, ingestCursors, events) {
  const sourceKeys = new Set();
  const positions = new Set();
  const maximumOffsets = new Map();
  for (const sourceEvent of sourceEvents) {
    requireObject(sourceEvent, 'source event');
    if (typeof sourceEvent.sourceKey !== 'string' || !sourceEvent.sourceKey.trim()
      || !Number.isSafeInteger(sourceEvent.sourceOffset) || sourceEvent.sourceOffset < 0
      || !events.has(sourceEvent.eventId)) {
      throw new Error('invalid event bundle: source event');
    }
    const position = `${sourceEvent.sourceKey}\u0000${sourceEvent.sourceOffset}`;
    if (positions.has(position)) throw new Error(`invalid event bundle: duplicate source position ${sourceEvent.sourceKey}`);
    positions.add(position);
    const maximum = maximumOffsets.get(sourceEvent.sourceKey);
    if (maximum === undefined || sourceEvent.sourceOffset > maximum) {
      maximumOffsets.set(sourceEvent.sourceKey, sourceEvent.sourceOffset);
    }
  }
  for (const cursor of ingestCursors) {
    requireObject(cursor, 'ingest cursor');
    if (typeof cursor.sourceKey !== 'string' || !cursor.sourceKey.trim() || sourceKeys.has(cursor.sourceKey)
      || typeof cursor.filePath !== 'string' || !cursor.filePath.trim()
      || !Number.isSafeInteger(cursor.byteOffset) || cursor.byteOffset < 0
      || (cursor.prefixHash !== null && !/^[a-f0-9]{64}$/u.test(cursor.prefixHash))
      || !validTimestamp(cursor.updatedAt)) {
      throw new Error(`invalid event bundle: ingest cursor ${String(cursor.sourceKey)}`);
    }
    const maximum = maximumOffsets.get(cursor.sourceKey);
    if (maximum !== undefined && maximum >= cursor.byteOffset) {
      throw new Error(`invalid event bundle: ingest cursor behind source ${cursor.sourceKey}`);
    }
    sourceKeys.add(cursor.sourceKey);
  }
  for (const sourceKey of maximumOffsets.keys()) {
    if (!sourceKeys.has(sourceKey)) throw new Error(`invalid event bundle: missing ingest cursor ${sourceKey}`);
  }
}

function decodeBase64(value, name) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`invalid event bundle: object encoding ${name}`);
  }
  return Buffer.from(value, 'base64');
}

function validateObjects(objects, events) {
  const references = new Map();
  for (const event of events.values()) collectObjectReferences(event.payload, references);
  const decoded = [];
  const seen = new Set();
  for (const object of objects) {
    requireObject(object, 'object');
    if (!/^sha256:[a-f0-9]{64}$/u.test(object.reference) || seen.has(object.reference)) {
      throw new Error(`invalid event bundle: object reference ${String(object.reference)}`);
    }
    const content = decodeBase64(object.data, object.reference);
    const actual = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
    if (actual !== object.reference || object.bytes !== content.length) {
      throw new Error(`invalid event bundle: object integrity ${object.reference}`);
    }
    const expectedSizes = references.get(object.reference);
    if (!expectedSizes || expectedSizes.some((size) => Number.isInteger(size) && size !== content.length)) {
      throw new Error(`invalid event bundle: unexpected object ${object.reference}`);
    }
    seen.add(object.reference);
    decoded.push({ reference: object.reference, content });
  }
  for (const reference of references.keys()) {
    if (!seen.has(reference)) throw new Error(`invalid event bundle: missing object ${reference}`);
  }
  return decoded;
}

export function createEventBundle(store) {
  const audit = store.verifyAll();
  if (!audit.valid) throw new Error(`cannot export invalid AgentGit history: ${audit.issues[0]?.kind ?? 'unknown issue'}`);
  const snapshot = store.exportSnapshot();
  const references = new Map();
  for (const event of snapshot.events) collectObjectReferences(event.payload, references);
  const objects = [...references.keys()].sort().map((reference) => {
    const content = readObject(store.repo, reference);
    return { reference, bytes: content.length, data: content.toString('base64') };
  });
  const body = {
    format: EVENT_BUNDLE_FORMAT,
    version: EVENT_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    schemaVersion: snapshot.schemaVersion,
    events: snapshot.events,
    refs: snapshot.refs,
    deliveries: snapshot.deliveries,
    sourceEvents: snapshot.sourceEvents,
    ingestCursors: snapshot.ingestCursors,
    objects,
  };
  return { ...body, bundleHash: sha256(body) };
}

export function validateEventBundle(bundle) {
  requireObject(bundle, 'root');
  if (canonicalJson(Object.keys(bundle).sort()) !== canonicalJson(TOP_LEVEL_KEYS)) {
    throw new Error('invalid event bundle: unexpected top-level fields');
  }
  if (bundle.format !== EVENT_BUNDLE_FORMAT || bundle.version !== EVENT_BUNDLE_VERSION) {
    throw new Error(`unsupported event bundle format or version: ${String(bundle.format)}@${String(bundle.version)}`);
  }
  if (!validTimestamp(bundle.exportedAt)) throw new Error('invalid event bundle: exportedAt');
  if (!Number.isInteger(bundle.schemaVersion) || bundle.schemaVersion < 1
    || bundle.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`unsupported event bundle schema version: ${String(bundle.schemaVersion)}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(bundle.bundleHash) || sha256(bundleBody(bundle)) !== bundle.bundleHash) {
    throw new Error('invalid event bundle: bundle hash mismatch');
  }
  const events = requireArray(bundle.events, 'events');
  const byId = validateEvents(events);
  const refs = requireArray(bundle.refs, 'refs');
  const deliveries = requireArray(bundle.deliveries, 'deliveries');
  const sourceEvents = requireArray(bundle.sourceEvents, 'sourceEvents');
  const ingestCursors = requireArray(bundle.ingestCursors, 'ingestCursors');
  validateRefs(refs, byId);
  validateDeliveries(deliveries, byId);
  validateIngest(sourceEvents, ingestCursors, byId);
  const objects = validateObjects(requireArray(bundle.objects, 'objects'), byId);
  return {
    snapshot: { events, refs, deliveries, sourceEvents, ingestCursors },
    objects,
  };
}

function writeAtomically(filePath, contents, overwrite) {
  const destination = path.resolve(filePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    if (overwrite) fs.renameSync(temporary, destination);
    else {
      fs.linkSync(temporary, destination);
      fs.unlinkSync(temporary);
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return destination;
}

export function exportEventBundle({ store, filePath, overwrite = false }) {
  const bundle = createEventBundle(store);
  const file = writeAtomically(filePath, `${JSON.stringify(bundle, null, 2)}\n`, overwrite);
  return {
    file,
    bundleHash: bundle.bundleHash,
    format: bundle.format,
    version: bundle.version,
    events: bundle.events.length,
    objects: bundle.objects.length,
  };
}

export function readEventBundle(filePath) {
  const absolute = path.resolve(filePath);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(absolute, 'utf8')); } catch (error) {
    throw new Error(`cannot read event bundle ${absolute}: ${error.message}`);
  }
  return { file: absolute, bundle: parsed };
}

export function importEventBundle({ store, filePath, replaceMutable = false }) {
  const { file, bundle } = readEventBundle(filePath);
  const validated = validateEventBundle(bundle);
  for (const object of validated.objects) {
    let existing = null;
    try { existing = readObject(store.repo, object.reference); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing) {
      if (!existing.equals(object.content)) throw new Error(`destination object differs: ${object.reference}`);
    } else {
      const written = putObject(store.repo, object.content);
      if (written.hash !== object.reference) throw new Error(`failed to restore object: ${object.reference}`);
    }
  }
  const result = store.importSnapshot(validated.snapshot, { replaceMutable });
  const audit = store.verifyAll();
  if (!audit.valid) throw new Error(`imported history failed verification: ${audit.issues[0]?.kind ?? 'unknown issue'}`);
  return {
    file,
    bundleHash: bundle.bundleHash,
    ...result,
    objects: validated.objects.length,
    valid: true,
  };
}
