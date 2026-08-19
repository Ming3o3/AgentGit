import crypto from 'node:crypto';

/** Return JSON with object keys sorted recursively for stable hashing. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
