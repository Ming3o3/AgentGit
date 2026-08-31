import { putObject } from './objects.mjs';

const INLINE_LIMIT = 8192;

const SENSITIVE_KEY_SOURCE = 'api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|token|client[_-]?secret|refresh[_-]?token|private[_-]?key';
const SENSITIVE_KEYS = new RegExp(`^(?:${SENSITIVE_KEY_SOURCE})$`, 'iu');

const SECRET_PATTERNS = [
  new RegExp(`(["']?\\b(?:${SENSITIVE_KEY_SOURCE})\\b["']?\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`, 'giu'),
  new RegExp(`(["']?\\b(?:${SENSITIVE_KEY_SOURCE})\\b["']?\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`, 'giu'),
  new RegExp(`(["']?\\b(?:${SENSITIVE_KEY_SOURCE})\\b["']?\\s*[:=])((?!\\s*["'])\\s*)[^\\r\\n,;}]+`, 'giu'),
  /\bBearer\s+[A-Za-z0-9._~+\-/=]{12,}/gu,
  /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,})\b/gu,
];

export function redactText(text) {
  let result = text;
  result = result.replace(SECRET_PATTERNS[0], '$1"[REDACTED]"');
  result = result.replace(SECRET_PATTERNS[1], "$1'[REDACTED]'");
  result = result.replace(SECRET_PATTERNS[2], '$1$2[REDACTED]');
  result = result.replace(SECRET_PATTERNS[3], 'Bearer [REDACTED]');
  result = result.replace(SECRET_PATTERNS[4], '[REDACTED]');
  return result;
}

export function sanitizePayload(value, repo, key = null, seen = new WeakSet()) {
  if (key !== null && SENSITIVE_KEYS.test(key)) return '[REDACTED]';
  if (value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return value.name ? `[Function: ${value.name}]` : '[Function]';
  if (typeof value === 'symbol') return value.description ? `[Symbol: ${value.description}]` : '[Symbol]';
  if (typeof value === 'string') {
    const safe = redactText(value);
    if (Buffer.byteLength(safe, 'utf8') <= INLINE_LIMIT) return safe;
    const object = putObject(repo, safe);
    return {
      objectRef: object.hash,
      bytes: object.bytes,
      preview: `${safe.slice(0, 512)}…`,
    };
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof RegExp || value instanceof URL) return String(value);
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const sanitized = {
      name: sanitizePayload(value.name, repo, 'name', seen),
      message: sanitizePayload(value.message, repo, 'message', seen),
      ...(value.code !== undefined ? { code: sanitizePayload(value.code, repo, 'code', seen) } : {}),
      ...(value.cause !== undefined ? { cause: sanitizePayload(value.cause, repo, 'cause', seen) } : {}),
    };
    seen.delete(value);
    return sanitized;
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const bytes = Buffer.isBuffer(value)
      ? value
      : value instanceof ArrayBuffer
        ? Buffer.from(value)
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const encoded = bytes.toString('base64');
    if (Buffer.byteLength(encoded, 'utf8') <= INLINE_LIMIT) {
      return { encoding: 'base64', data: encoded, bytes: bytes.length };
    }
    const object = putObject(repo, bytes);
    return { objectRef: object.hash, bytes: object.bytes, encoding: 'binary' };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const sanitized = value.map((item) => sanitizePayload(item, repo, null, seen));
    seen.delete(value);
    return sanitized;
  }
  if (value instanceof Map) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const sanitized = [...value.entries()].map(([entryKey, item]) => [
      sanitizePayload(entryKey, repo, null, seen),
      sanitizePayload(item, repo, null, seen),
    ]);
    seen.delete(value);
    return sanitized;
  }
  if (value instanceof Set) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const sanitized = [...value].map((item) => sanitizePayload(item, repo, null, seen));
    seen.delete(value);
    return sanitized;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(value); } catch {
      seen.delete(value);
      return '[Unserializable]';
    }
    const sanitized = Object.fromEntries(Object.entries(descriptors)
      .filter(([, descriptor]) => descriptor.enumerable)
      .map(([childKey, descriptor]) => [
        childKey,
        'value' in descriptor ? sanitizePayload(descriptor.value, repo, childKey, seen) : '[Accessor]',
      ]));
    seen.delete(value);
    return sanitized;
  }
  return value;
}
