/** Express plumbing: errors, validation, sessions, role checks and login throttling. */
import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { fieldErrors } from '@shared/schemas';
import { config } from './config';
import { sessions, users, type UserRow } from './repo';
import { randomToken, sha256Hex } from './security';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
      sessionId?: string;
    }
  }
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new HttpError(422, 'Please check the highlighted fields.', fieldErrors(result.error));
  return result.data;
}

export function currentUser(req: Request): UserRow {
  if (!req.user) throw new HttpError(401, 'Please sign in to continue.');
  return req.user;
}

export function pageQuery(req: Request): { q: string; page: number; pageSize: number; offset: number } {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(String(req.query.pageSize ?? '25'), 10) || 25));
  return { q, page, pageSize, offset: (page - 1) * pageSize };
}

/* ------------------------------------------------------------- sessions */

export const SESSION_COOKIE = 'ec_session';
const sessionMs = () => config.sessionHours * 3_600_000;
/** Scoped to the app's path, so the cookie is never sent to the Shichida admin app on the same site. */
const cookiePath = config.basePath || '/';

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: cookiePath,
    maxAge: sessionMs(),
  });
}

export async function startSession(req: Request, res: Response, user: UserRow): Promise<void> {
  const token = randomToken(32);
  await sessions.create({
    id: sha256Hex(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + sessionMs()).toISOString(),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    ip: req.ip ?? '',
  });
  setSessionCookie(res, token);
}

export async function endSession(req: Request, res: Response): Promise<void> {
  if (req.sessionId) await sessions.delete(req.sessionId);
  res.clearCookie(SESSION_COOKIE, { path: cookiePath, httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });
}

/** Attaches req.user from the session cookie, renewing sessions that are past their half-life. */
export async function loadSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const id = sha256Hex(token);
    const session = await sessions.findValid(id);
    const user = session ? await users.byId(session.user_id) : undefined;
    if (session && user && user.active === 1) {
      req.user = user;
      req.sessionId = id;
      if (Date.parse(session.expires_at) - Date.now() < sessionMs() / 2) {
        await sessions.extend(id, new Date(Date.now() + sessionMs()).toISOString());
        setSessionCookie(res, token);
      }
    }
  }
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  next(req.user ? undefined : new HttpError(401, 'Please sign in to continue.'));
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'Please sign in to continue.'));
  next(req.user.role === 'admin' ? undefined : new HttpError(403, 'Only administrators can do that.'));
}

/**
 * CSRF defence for cookie-authenticated writes: a custom header cannot be added cross-site
 * without a CORS preflight, which this API never grants. Works together with SameSite=Lax.
 */
export function requireAppHeader(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  next(req.get('x-requested-with') === 'EarlyCompass' ? undefined : new HttpError(403, 'Request blocked.'));
}

/* -------------------------------------------------------- login throttle */

const WINDOW_MS = 15 * 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

function bucket(key: string): { count: number; resetAt: number } {
  const now = Date.now();
  let entry = failures.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    failures.set(key, entry);
  }
  return entry;
}

/** 5 failures per account+address and 30 per address in 15 minutes. */
export function loginBlockedFor(ip: string, email: string): number {
  const account = bucket(`${ip}|${email}`);
  const address = bucket(ip);
  const blocked = account.count >= 5 ? account : address.count >= 30 ? address : null;
  return blocked ? Math.ceil((blocked.resetAt - Date.now()) / 1000) : 0;
}

export function recordLoginFailure(ip: string, email: string): void {
  bucket(`${ip}|${email}`).count++;
  bucket(ip).count++;
}

export function clearLoginFailures(ip: string, email: string): void {
  failures.delete(`${ip}|${email}`);
}

// Expired sessions are removed by DynamoDB's expiry; only the throttle needs sweeping.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
}, WINDOW_MS).unref();

/* --------------------------------------------------------------- errors */

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, fieldErrors: error.fieldErrors });
    return;
  }
  if ((error as { name?: string } | null)?.name === 'ConflictError') {
    res.status(409).json({ error: (error as Error).message });
    return;
  }
  const type = (error as { type?: string } | null)?.type;
  if (type === 'entity.too.large') {
    res.status(413).json({ error: 'That request is too large.' });
    return;
  }
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: 'The request body is not valid JSON.' });
    return;
  }
  console.error(`[error] ${req.method} ${req.originalUrl}`, error);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
}
