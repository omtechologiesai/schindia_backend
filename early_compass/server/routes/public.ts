/**
 * The page a parent opens from the email or WhatsApp link: no sign-in, protected by the
 * signed, expiring token. Shows the compass snapshot with buttons to open or download the PDF.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { COLORS } from '@shared/brand';
import { DISCLAIMER_FOOTER, DISCLAIMER_NOT_DIAGNOSTIC, ORG_NAME, PRODUCT_NAME } from '@shared/copy';
import { BAND_LABEL } from '@shared/domain';
import { formatDate } from '@shared/format';
import { config } from '../config';
import { parseAssessment } from '../repo';
import { readReportFile, readReportPdf, reportFileName, resolveShareToken } from '../services/reports';

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let logoDataUri: string | null = null;
const logo = () =>
  (logoDataUri ??= `data:image/png;base64,${fs.readFileSync(path.join(config.assetsDir, 'brand', 'shichida-india-logo.png')).toString('base64')}`);

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:${COLORS.paper};color:${COLORS.ink};font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:24px 16px 40px}
.card{background:#fff;border:1px solid ${COLORS.line};border-radius:22px;overflow:hidden;box-shadow:0 2px 6px rgba(60,60,40,.04),0 6px 16px rgba(60,60,40,.05)}
.sun{height:5px;background:${COLORS.sun}}
.inner{padding:22px 22px 26px}
.brand{display:flex;align-items:center;gap:12px}
.brand img{width:34px;height:44px}
.brand b{display:block;font-size:17px;font-weight:800;line-height:1.2}
.brand span{font-size:13px;color:${COLORS.muted};font-weight:600}
h1{font-size:26px;line-height:1.2;margin:22px 0 4px;letter-spacing:-.02em}
.meta{color:${COLORS.ink2};margin:0 0 18px;font-size:15px}
.snapshot{display:block;width:100%;height:auto;border:1px solid ${COLORS.line};border-radius:16px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0 6px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 20px;border-radius:12px;font-weight:700;text-decoration:none;font-size:16px;flex:1 1 200px}
.btn-primary{background:${COLORS.brand};color:#fff}
.btn-secondary{background:#fff;color:${COLORS.ink};border:1px solid ${COLORS.lineStrong}}
.hint{font-size:13px;color:${COLORS.muted};margin:8px 0 0}
.notice{margin-top:20px;padding:14px 16px;border:1px solid ${COLORS.lineStrong};border-radius:12px;background:${COLORS.surface2};font-size:14px;color:${COLORS.ink2}}
.notice b{display:block;color:${COLORS.ink};margin-bottom:2px}
footer{font-size:12.5px;color:${COLORS.muted};text-align:center;margin-top:18px;padding:0 8px}
`;

function page(title: string, inner: string): string {
  const contact = [config.contact.phone, config.contact.email, config.contact.website].filter(Boolean).map(esc).join(' · ');
  return `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body><main class="wrap"><div class="card"><div class="sun"></div><div class="inner"><div class="brand"><img src="${logo()}" alt=""><div><b>${ORG_NAME}</b><span>${PRODUCT_NAME} report</span></div></div>${inner}</div></div><footer>${esc(DISCLAIMER_FOOTER)}${contact ? `<br>${contact}` : ''}</footer></main></body></html>`;
}

const unavailable = () =>
  page(
    `Report link unavailable · ${ORG_NAME}`,
    `<h1>This report link has expired</h1><p class="meta">For privacy, report links stop working after a while or when a new one is sent. Please ask your ${ORG_NAME} centre to share the report again.</p>`,
  );

export const publicRouter = Router();

publicRouter.use((_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

publicRouter.get('/:token', async (req, res) => {
  const row = await resolveShareToken(String(req.params.token));
  if (!row || row.report_version < 1) {
    res.status(404).type('html').send(unavailable());
    return;
  }
  const detail = parseAssessment(row);
  const link = `${config.basePath}/r/${encodeURIComponent(String(req.params.token))}`;
  const first = esc(detail.child.firstName);
  const band = BAND_LABEL[row.band];
  res.type('html').send(
    page(
      `${detail.child.firstName}’s ${PRODUCT_NAME} report · ${ORG_NAME}`,
      `<h1>${first}’s ${PRODUCT_NAME} report</h1>
       <p class="meta">Assessment on ${formatDate(row.assessed_at, config.timeZone, 'long')} · ${band} checklist · Ref ${esc(row.reference)}</p>
       <img class="snapshot" src="${link}/snapshot.png" width="600" height="860" alt="${first}’s compass reading: ${Math.round(row.overall_pct)}% of ${band} milestones observed">
       <div class="actions">
         <a class="btn btn-primary" href="${link}/report.pdf?download=1">Download PDF report</a>
         <a class="btn btn-secondary" href="${link}/report.pdf" target="_blank" rel="noopener">Open in browser</a>
       </div>
       <p class="hint">This private link was shared with you by ${ORG_NAME} and works until ${formatDate(row.share_expires_at, config.timeZone, 'long')}.</p>
       <div class="notice"><b>${DISCLAIMER_NOT_DIAGNOSTIC.title}</b>${esc(DISCLAIMER_NOT_DIAGNOSTIC.body)}</div>`,
    ),
  );
});

publicRouter.get('/:token/report.pdf', async (req, res) => {
  const row = await resolveShareToken(String(req.params.token));
  // The report staff shared last: the whole thing, or its first pages.
  const variant = row?.share_variant ?? 'full';
  const pdf = row ? await readReportPdf(row, variant) : null;
  if (!row || !pdf) {
    res.status(404).type('html').send(unavailable());
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${reportFileName(row, undefined, variant)}"`);
  // Mobile and desktop browsers' PDF viewers refuse to render under the object-src 'none' policy.
  res.removeHeader('Content-Security-Policy');
  res.send(pdf);
});

publicRouter.get('/:token/snapshot.png', async (req, res) => {
  const row = await resolveShareToken(String(req.params.token));
  const png = row ? await readReportFile(row, 'snapshot') : null;
  if (!png) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.send(png);
});
