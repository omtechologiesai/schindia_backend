import { Router } from 'express';
import type { MetaDTO } from '@shared/api';
import { ORG_NAME, PRODUCT_NAME } from '@shared/copy';
import { config } from '../config';
import { HttpError } from '../http';
import { deliveries } from '../repo';
import { emailMode } from '../services/email';
import { syncEnabled } from '../services/sync';
import { whatsappMode } from '../services/whatsapp';
import { files, outboxKey } from '../storage';

export const metaRouter = Router();

metaRouter.get('/', (_req, res) => {
  res.json({
    orgName: ORG_NAME,
    productName: PRODUCT_NAME,
    timeZone: config.timeZone,
    email: { mode: emailMode, from: config.mailFrom },
    whatsapp: { mode: whatsappMode, templateName: config.whatsapp?.templateName ?? null },
    publicBaseUrl: config.publicBaseUrl,
    publicLinksReachable: config.publicLinksReachable,
    reportLinkDays: config.reportLinkDays,
    centres: config.centres,
    sync: { enabled: syncEnabled },
    contact: config.contact,
  } satisfies MetaDTO);
});

export const deliveriesRouter = Router();

/** The .eml of an email saved in preview mode, to open in any mail app. */
deliveriesRouter.get('/:id/preview.eml', async (req, res) => {
  const row = await deliveries.byId(String(req.params.id ?? ''));
  if (!row || row.preview_path !== outboxKey(row.id)) {
    throw new HttpError(404, 'No email preview is stored for this delivery.');
  }
  const eml = await files.get(row.preview_path);
  if (!eml) throw new HttpError(404, 'The email preview file is missing.');
  res.setHeader('Content-Type', 'message/rfc822');
  res.setHeader('Content-Disposition', `attachment; filename="early-compass-email-${row.id.slice(0, 8)}.eml"`);
  res.send(eml);
});
