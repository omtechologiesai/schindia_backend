import { Router } from 'express';
import { createUserSchema, updateUserSchema } from '@shared/schemas';
import { currentUser, HttpError, parseBody, requireAdmin } from '../http';
import { sessions, toUserDTO, users } from '../repo';
import { hashPassword } from '../security';

export const usersRouter = Router();
usersRouter.use(requireAdmin);

usersRouter.get('/', async (_req, res) => {
  res.json((await users.list()).map(toUserDTO));
});

usersRouter.post('/', async (req, res) => {
  const input = parseBody(createUserSchema, req.body);
  if (await users.byEmail(input.email)) {
    throw new HttpError(409, 'A staff account with that email already exists.', { email: 'This email already has an account' });
  }
  const row = await users.create({
    email: input.email,
    name: input.name,
    role: input.role,
    centre: input.centre,
    passwordHash: await hashPassword(input.password),
  });
  res.status(201).json(toUserDTO(row));
});

usersRouter.patch('/:id', async (req, res) => {
  const me = currentUser(req);
  const input = parseBody(updateUserSchema, req.body);
  const target = await users.byId(String(req.params.id ?? ''));
  if (!target) throw new HttpError(404, 'That staff account could not be found.');

  const losesAdmin =
    target.role === 'admin' && target.active === 1 && ((input.role && input.role !== 'admin') || input.active === false);
  if (losesAdmin && (await users.activeAdminCount()) <= 1) {
    throw new HttpError(409, 'Keep at least one active administrator.');
  }

  const updated = await users.update(target.id, {
    name: input.name,
    role: input.role,
    centre: input.centre,
    active: input.active,
    passwordHash: input.password ? await hashPassword(input.password) : undefined,
  });
  if (!updated) throw new HttpError(404, 'That staff account could not be found.');
  // A reset password or a deactivated account signs that person out everywhere.
  if ((input.password || input.active === false) && target.id !== me.id) await sessions.deleteForUser(target.id);
  res.json(toUserDTO(updated));
});
