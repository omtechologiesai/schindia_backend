import crypto from 'node:crypto';
import { config } from './config';

const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64, maxmem: 64 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, { N, r, p, maxmem: SCRYPT.maxmem }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** "scrypt$N$r$p$salt$key", so cost parameters can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLength);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;

/** Spends the same time as a real check when the account doesn't exist, so logins can't probe for emails. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(crypto.randomBytes(12).toString('hex'));
  await verifyPassword(password, await dummyHash);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Parent share links are "/r/<assessmentId>.<signature>". The signature covers a per-record
 * nonce and the expiry, so rotating the nonce revokes every earlier link and nothing
 * secret is stored in the database.
 */
function shareSignature(assessmentId: string, nonce: string, expiresAt: string): string {
  return crypto
    .createHmac('sha256', config.appSecret)
    .update(`share:${assessmentId}:${nonce}:${expiresAt}`)
    .digest('base64url')
    .slice(0, 32);
}

export function shareToken(assessmentId: string, nonce: string, expiresAt: string): string {
  return `${assessmentId}.${shareSignature(assessmentId, nonce, expiresAt)}`;
}

export function parseShareToken(token: string): { assessmentId: string; signature: string } | null {
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32})$/.exec(token);
  return match ? { assessmentId: match[1]!, signature: match[2]! } : null;
}

export function isValidShareSignature(
  assessmentId: string,
  signature: string,
  nonce: string,
  expiresAt: string,
): boolean {
  return safeEqual(signature, shareSignature(assessmentId, nonce, expiresAt));
}

export function hmacSha256Hex(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
