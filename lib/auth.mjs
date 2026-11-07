import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './store.mjs';

const scrypt = promisify(scryptCallback);
const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const hashToken = token => createHash('sha256').update(token).digest('hex');
export function username(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value))
    fail(400, 'Username must start with a lowercase letter and contain up to 32 lowercase letters, digits, underscores or hyphens.');
  return value;
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024)
    fail(400, 'Password must contain 8 to 1024 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, parameters);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  const [, salt, digest] = stored.split(':');
  const key = await scrypt(password, salt, 64, parameters);
  const expected = Buffer.from(digest, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
export function newSession(store, user, ttl) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  store.run('DELETE FROM sessions WHERE expires<=?', Date.now());
  store.run('INSERT INTO sessions(hash,user_id,csrf,expires) VALUES(?,?,?,?)',
    hashToken(token), user.id, csrf, Date.now() + ttl);
  return { token, csrf };
}
export function session(store, token) {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return store.get(`SELECT u.id,u.username,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.hash=? AND s.expires>? AND u.disabled=0`, hashToken(token), Date.now()) || null;
}

export class LoginLimiter {
  constructor() { this.entries = new Map(); }
  check(key, limit = 10) {
    const now = Date.now();
    for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
    const row = this.entries.get(key);
    if (row && row.count >= limit) fail(429, 'Too many login attempts. Try again in 15 minutes.');
    if (!row && this.entries.size >= 10000) fail(429, 'Login temporarily busy. Try later.');
    this.entries.set(key, { count: (row?.count || 0) + 1, until: row?.until || now + 15 * 60000 });
  }
}
