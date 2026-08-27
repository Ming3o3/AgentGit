import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function normalizeHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw new Error('invalid object hash');
  }
  return value.toLowerCase();
}

export function objectPath(repo, hash) {
  const normalized = normalizeHash(hash);
  return path.join(path.resolve(repo), '.agentgit', 'objects', normalized.slice(0, 2), normalized.slice(2));
}

export function putObject(repo, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const destination = objectPath(repo, hash);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try { fs.writeFileSync(destination, bytes, { flag: 'wx' }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return { hash: `sha256:${hash}`, bytes: bytes.length };
}

export function readObject(repo, reference) {
  if (typeof reference !== 'string') throw new Error('invalid object reference');
  const hash = normalizeHash(reference.replace(/^sha256:/iu, ''));
  return fs.readFileSync(objectPath(repo, hash));
}
