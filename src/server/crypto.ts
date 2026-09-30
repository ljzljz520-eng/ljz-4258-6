import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expected: string) {
  const actual = Buffer.from(scryptSync(password, salt, 64));
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalHash(value: unknown) {
  return sha256(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

export function newId(prefix: string) {
  return `${prefix}_${randomBytes(10).toString('hex')}`;
}

export function newToken() {
  return randomBytes(32).toString('hex');
}
