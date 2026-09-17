import { Router } from 'express';
import type { ChecklistDTO } from '@shared/api';
import { checklist } from '../repo';

/**
 * The milestone checklist is read-only: it is the original Shichida set, and nothing in the portal
 * or the API can add, change or remove a question. Assessments still record the wording they were
 * answered with, so old reports stay exactly as they were.
 */
export const checklistRouter = Router();

checklistRouter.get('/', async (_req, res) => {
  const [version, items] = await Promise.all([checklist.version(), checklist.current()]);
  res.json({ version, items } satisfies ChecklistDTO);
});
