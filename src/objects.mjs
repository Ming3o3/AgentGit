import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function objectPath(repo, hash) {
  return path.join(path.resolve(repo), '.agentgit', 'objects', hash.slice(0, 2), hash.slice(2));
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
  const hash = reference.replace(/^sha256:/, '');
  return fs.readFileSync(objectPath(repo, hash));
}
