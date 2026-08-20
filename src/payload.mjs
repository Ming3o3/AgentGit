import { putObject } from './objects.mjs';

const INLINE_LIMIT = 8192;

const SECRET_PATTERNS = [
  /((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|token)\s*[:=]\s*["']?)([^\s,"']{8,})/giu,
  /\bBearer\s+[A-Za-z0-9._~+\-/=]{12,}/gu,
  /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{20,})\b/gu,
];

export function redactText(text) {
  let result = text;
  result = result.replace(SECRET_PATTERNS[0], '$1[REDACTED]');
  result = result.replace(SECRET_PATTERNS[1], 'Bearer [REDACTED]');
  result = result.replace(SECRET_PATTERNS[2], '[REDACTED]');
  return result;
}

export function sanitizePayload(value, repo) {
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
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item, repo));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePayload(item, repo)]));
  }
  return value;
}
