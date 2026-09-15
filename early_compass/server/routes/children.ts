import { Router, type Request } from 'express';
import type { ChildListItemDTO, ChildProfileDTO, Paginated } from '@shared/api';
import { ageInMonths } from '@shared/format';
import { normalisePhone } from '@shared/phone';
import { updateChildSchema } from '@shared/schemas';
import { config } from '../config';
import { HttpError, pageQuery, parseBody, requireAdmin } from '../http';
import { assessments, children, deliveries, toChildDTO, toReadingSummary, type ChildRow } from '../repo';
import { files, reportPrefix } from '../storage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function findChild(req: Request): Promise<ChildRow> {
  const id = String(req.params.id ?? '');
  const row = UUID.test(id) ? await children.byId(id) : undefined;
  if (!row) throw new HttpError(404, 'That child could not be found.');
  return row;
}

export const childrenRouter = Router();

childrenRouter.get('/', async (req, res) => {
  const { q, page, pageSize, offset } = pageQuery(req);
  const { items, total } = await children.list({ q, limit: pageSize, offset });
  res.json({ items, total, page, pageSize } satisfies Paginated<ChildListItemDTO>);
});

childrenRouter.get('/:id', async (req, res) => {
  const row = await findChild(req);
  const history = (await assessments.forChild(row.id)).map((a) => ({
    ...toReadingSummary(a),
    assessorName: a.assessor_name,
    reportReady: a.report_version > 0,
  }));
  res.json({ ...toChildDTO(row), assessments: history } satisfies ChildProfileDTO);
});

childrenRouter.put('/:id', async (req, res) => {
  const row = await findChild(req);
  const input = parseBody(updateChildSchema, req.body);
  if (ageInMonths(input.child.dateOfBirth, new Date(), config.timeZone) === null) {
    throw new HttpError(422, 'Please check the highlighted fields.', { 'child.dateOfBirth': 'Date of birth cannot be in the future' });
  }
  const phone = normalisePhone(input.parent.phone)!;
  const updated = await children.update(row.id, {
    child: input.child,
    parent: { ...input.parent, phone: phone.e164, email: input.parent.email.toLowerCase() },
  });
  if (!updated) throw new HttpError(404, 'That child could not be found.');
  res.json(toChildDTO(updated));
});

/** Erases a child and every assessment, report file and email preview (e.g. on a parent's request). */
childrenRouter.delete('/:id', requireAdmin, async (req, res) => {
  const row = await findChild(req);
  const ids = (await assessments.forChild(row.id)).map((a) => a.id);
  const previews = (await Promise.all(ids.map((id) => deliveries.forAssessment(id))))
    .flat()
    .flatMap((d) => (d.preview_path ? [d.preview_path] : []));
  for (const id of ids) await assessments.delete(id);
  await children.delete(row.id);
  await Promise.all([...ids.map((id) => files.removePrefix(reportPrefix(id))), ...previews.map((key) => files.remove(key))]);
  res.status(204).end();
});
