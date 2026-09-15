import { Router } from 'express';
import type { ChecklistDTO } from '@shared/api';
import { checklistItemSchema } from '@shared/schemas';
import { currentUser, HttpError, parseBody, requireAdmin } from '../http';
import { checklist } from '../repo';

const current = async (): Promise<ChecklistDTO> => {
  const [version, items] = await Promise.all([checklist.version(), checklist.current()]);
  return { version, items };
};

export const checklistRouter = Router();

checklistRouter.get('/', async (_req, res) => {
  res.json(await current());
});

/** Adds a question to the end of an area's list. Saved assessments keep the questions they were answered with. */
checklistRouter.post('/', requireAdmin, async (req, res) => {
  const input = parseBody(checklistItemSchema, req.body);
  if (await checklist.hasText(input.band, input.domain, input.text)) {
    throw new HttpError(409, 'That question is already in this list.', { text: 'This question is already in the list' });
  }
  await checklist.add({ ...input, userId: currentUser(req).id });
  res.status(201).json(await current());
});

checklistRouter.delete('/:id', requireAdmin, async (req, res) => {
  const item = await checklist.byId(String(req.params.id ?? ''));
  if (!item || item.removed_at) throw new HttpError(404, 'That question could not be found.');
  if ((await checklist.activeCount(item.band, item.domain)) <= 1) {
    throw new HttpError(409, 'Each area needs at least one question, so this one can’t be removed.');
  }
  await checklist.remove(item.id, currentUser(req).id);
  res.json(await current());
});
