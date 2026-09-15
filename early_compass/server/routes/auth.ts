import { Router } from 'express';
import { changePasswordSchema, loginSchema } from '@shared/schemas';
import {
  clearLoginFailures,
  currentUser,
  endSession,
  HttpError,
  loginBlockedFor,
  parseBody,
  recordLoginFailure,
  startSession,
} from '../http';
import { sessions, toUserDTO, users } from '../repo';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../security';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { email, password } = parseBody(loginSchema, req.body);
  const ip = req.ip ?? 'unknown';
  const waitSeconds = loginBlockedFor(ip, email);
  if (waitSeconds > 0) {
    res.setHeader('Retry-After', String(waitSeconds));
    throw new HttpError(429, `Too many sign-in attempts. Try again in ${Math.ceil(waitSeconds / 60)} minutes.`);
  }
  const user = await users.byEmail(email);
  let valid = false;
  if (user) valid = await verifyPassword(password, user.password_hash);
  else await burnPasswordCheck(password);
  if (!user || !valid || user.active !== 1) {
    recordLoginFailure(ip, email);
    throw new HttpError(401, 'That email and password combination is not recognised.');
  }
  clearLoginFailures(ip, email);
  await startSession(req, res, user);
  await users.recordLogin(user.id);
  res.json(toUserDTO((await users.byId(user.id))!));
});

authRouter.post('/logout', async (req, res) => {
  await endSession(req, res);
  res.status(204).end();
});

authRouter.get('/me', (req, res) => {
  res.json(toUserDTO(currentUser(req)));
});

authRouter.post('/password', async (req, res) => {
  const user = currentUser(req);
  const { currentPassword, newPassword } = parseBody(changePasswordSchema, req.body);
  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    throw new HttpError(422, 'Please check the highlighted fields.', { currentPassword: 'Current password is incorrect' });
  }
  const updated = await users.update(user.id, { passwordHash: await hashPassword(newPassword) });
  // Sign out every other device, then keep this one signed in.
  await sessions.deleteForUser(user.id);
  await startSession(req, res, updated ?? user);
  res.status(204).end();
});
