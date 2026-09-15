import { Router, type Request } from 'express';
import type { AssessmentListItemDTO, EmailShareResult, Paginated, WhatsAppShareResult } from '@shared/api';
import { formatDate } from '@shared/format';
import { normalisePhone } from '@shared/phone';
import { assessmentSubmissionSchema, shareEmailSchema, shareWhatsAppSchema, updateChildSchema } from '@shared/schemas';
import { config } from '../config';
import { currentUser, HttpError, pageQuery, parseBody, requireAdmin } from '../http';
import { assessments, children, deliveries, newId, parseAssessment, toDeliveryDTO, type AssessmentRow } from '../repo';
import { createAssessment, updateAssessmentDetails } from '../services/assessments';
import { emailMode, sendReportEmail } from '../services/email';
import {
  ensureShareLink,
  errorMessage,
  generateReport,
  readReportFile,
  reportFileName,
  revokeShareLinks,
  shareUrl,
  toAssessmentDTO,
} from '../services/reports';
import { syncAssessment, syncEnabled } from '../services/sync';
import { buildWhatsAppMessage, clickToChatUrl, sendReportViaCloudApi, whatsappMode } from '../services/whatsapp';
import { files, outboxKey, reportPrefix } from '../storage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function findAssessment(req: Request): Promise<AssessmentRow> {
  const id = String(req.params.id ?? '');
  const row = UUID.test(id) ? await assessments.byId(id) : undefined;
  if (!row) throw new HttpError(404, 'That assessment could not be found.');
  return row;
}

async function reportPdfOrFail(row: AssessmentRow): Promise<Buffer> {
  const pdf = await readReportFile(row, 'pdf');
  if (!pdf) throw new HttpError(409, 'The report has not been generated yet. Use “Generate report” and try again.');
  return pdf;
}

/** Contact details as they are now (they may have been corrected since the assessment). */
async function currentContact(row: AssessmentRow) {
  const detail = parseAssessment(row);
  const child = await children.byId(row.child_id);
  return {
    detail,
    parentName: child?.parent_name ?? detail.child.parent.name,
    centre: child?.centre ?? detail.child.centre,
  };
}

export const assessmentsRouter = Router();

assessmentsRouter.get('/', async (req, res) => {
  const { q, page, pageSize, offset } = pageQuery(req);
  const { items, total } = await assessments.list({ q, limit: pageSize, offset });
  res.json({ items, total, page, pageSize } satisfies Paginated<AssessmentListItemDTO>);
});

assessmentsRouter.post('/', async (req, res) => {
  const input = parseBody(assessmentSubmissionSchema, req.body);
  const row = await createAssessment(input, currentUser(req));
  res.status(201).json(await toAssessmentDTO(row));
});

assessmentsRouter.get('/:id', async (req, res) => {
  res.json(await toAssessmentDTO(await findAssessment(req)));
});

const FILES = [
  { route: 'report.pdf', kind: 'pdf', contentType: 'application/pdf', suffix: '.pdf' },
  { route: 'chart.png', kind: 'chart', contentType: 'image/png', suffix: '_chart.png' },
  { route: 'snapshot.png', kind: 'snapshot', contentType: 'image/png', suffix: '_snapshot.png' },
] as const;

for (const file of FILES) {
  assessmentsRouter.get(`/:id/${file.route}`, async (req, res) => {
    const row = await findAssessment(req);
    const data = await readReportFile(row, file.kind);
    if (!data) throw new HttpError(404, 'This file has not been generated yet.');
    const name = reportFileName(row).replace(/\.pdf$/, file.suffix);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    // Chrome's built-in PDF viewer refuses to render under the app's object-src 'none' policy.
    if (file.kind === 'pdf') res.removeHeader('Content-Security-Policy');
    res.send(data);
  });
}

/** Corrects the child's and parent's details, and renders a new report version when they changed. */
assessmentsRouter.put('/:id/details', async (req, res) => {
  const row = await findAssessment(req);
  const input = parseBody(updateChildSchema, req.body);
  res.json(await toAssessmentDTO(await updateAssessmentDetails(row, input)));
});

assessmentsRouter.post('/:id/regenerate', async (req, res) => {
  const row = await findAssessment(req);
  try {
    await generateReport(row.id);
  } catch (error) {
    throw new HttpError(500, `The report could not be generated: ${errorMessage(error)}`);
  }
  const saved = (await assessments.byId(row.id))!;
  if (syncEnabled && saved.sync_status !== 'synced') void syncAssessment(saved.id);
  res.json(await toAssessmentDTO(saved));
});

assessmentsRouter.post('/:id/share/email', async (req, res) => {
  const user = currentUser(req);
  const { to, message } = parseBody(shareEmailSchema, req.body);
  const found = await findAssessment(req);
  const pdf = await reportPdfOrFail(found);
  const chartImage = await readReportFile(found, 'chart');
  const row = await ensureShareLink(found);
  const { detail, parentName, centre } = await currentContact(row);
  const deliveryId = newId();
  const base = {
    id: deliveryId,
    assessmentId: row.id,
    channel: 'email' as const,
    mode: emailMode,
    recipient: to.toLowerCase(),
    reportVersion: row.report_version,
    sentBy: user.id,
  };
  try {
    const result = await sendReportEmail({
      to,
      parentName,
      childFirstName: detail.child.firstName,
      childFullName: `${detail.child.firstName} ${detail.child.lastName}`,
      centre,
      assessedAt: row.assessed_at,
      band: row.band,
      overallPct: row.overall_pct,
      stats: detail.stats,
      focusDomains: detail.focusAreas.map((area) => area.domain),
      shareUrl: shareUrl(row),
      shareExpiresAt: row.share_expires_at,
      personalMessage: message,
      senderName: user.name,
      pdf,
      pdfFileName: reportFileName(row, detail),
      chartImage,
    });
    let previewPath: string | null = null;
    if (result.previewEml) {
      previewPath = outboxKey(deliveryId);
      await files.put(previewPath, result.previewEml, 'message/rfc822');
    }
    const delivery = await deliveries.create({
      ...base,
      status: emailMode === 'preview' ? 'prepared' : 'sent',
      providerMessageId: result.messageId || null,
      error: null,
      previewPath,
    });
    res.json({ delivery: toDeliveryDTO(delivery) } satisfies EmailShareResult);
  } catch (error) {
    const delivery = await deliveries.create({ ...base, status: 'failed', providerMessageId: null, error: errorMessage(error), previewPath: null });
    res.status(502).json({ error: `The email could not be sent: ${errorMessage(error)}`, delivery: toDeliveryDTO(delivery) });
  }
});

assessmentsRouter.post('/:id/share/whatsapp', async (req, res) => {
  const user = currentUser(req);
  const { to } = parseBody(shareWhatsAppSchema, req.body);
  const phone = normalisePhone(to)!;
  const found = await findAssessment(req);
  const pdf = await reportPdfOrFail(found);
  const row = await ensureShareLink(found);
  const { detail, parentName, centre } = await currentContact(row);
  const message = buildWhatsAppMessage({
    parentName,
    childFirstName: detail.child.firstName,
    centre,
    assessedAt: row.assessed_at,
    shareUrl: shareUrl(row),
    shareExpiresAt: row.share_expires_at,
    senderName: user.name,
  });
  const base = {
    assessmentId: row.id,
    channel: 'whatsapp' as const,
    mode: whatsappMode,
    recipient: phone.e164,
    reportVersion: row.report_version,
    sentBy: user.id,
    previewPath: null,
  };

  if (whatsappMode === 'click_to_chat') {
    const delivery = await deliveries.create({ ...base, status: 'prepared', providerMessageId: null, error: null });
    res.json({ delivery: toDeliveryDTO(delivery), url: clickToChatUrl(phone.e164, message), message } satisfies WhatsAppShareResult);
    return;
  }

  try {
    const { messageId } = await sendReportViaCloudApi({
      to: phone.e164,
      pdf,
      fileName: reportFileName(row, detail),
      caption: message,
      parentName,
      childFirstName: detail.child.firstName,
      assessedAtText: formatDate(row.assessed_at, config.timeZone, 'long'),
    });
    const delivery = await deliveries.create({ ...base, status: 'sent', providerMessageId: messageId || null, error: null });
    res.json({ delivery: toDeliveryDTO(delivery), url: null, message } satisfies WhatsAppShareResult);
  } catch (error) {
    const delivery = await deliveries.create({ ...base, status: 'failed', providerMessageId: null, error: errorMessage(error) });
    res.status(502).json({ error: `The WhatsApp message could not be sent: ${errorMessage(error)}`, delivery: toDeliveryDTO(delivery) });
  }
});

assessmentsRouter.post('/:id/share-link/revoke', async (req, res) => {
  res.json(await toAssessmentDTO(await revokeShareLinks(await findAssessment(req))));
});

assessmentsRouter.post('/:id/sync', async (req, res) => {
  const row = await findAssessment(req);
  if (!syncEnabled) throw new HttpError(409, 'Sync to the internal system is not configured.');
  if (row.report_version < 1) throw new HttpError(409, 'Generate the report before syncing.');
  await syncAssessment(row.id);
  res.json(await toAssessmentDTO((await assessments.byId(row.id))!));
});

assessmentsRouter.delete('/:id', requireAdmin, async (req, res) => {
  const row = await findAssessment(req);
  const previews = (await deliveries.forAssessment(row.id)).flatMap((d) => (d.preview_path ? [d.preview_path] : []));
  await assessments.delete(row.id);
  await files.removePrefix(reportPrefix(row.id));
  await Promise.all(previews.map((key) => files.remove(key)));
  res.status(204).end();
});
