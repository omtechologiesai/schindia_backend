/**
 * Report emails to parents with the PDF attached, in one of three modes (EMAIL_MODE):
 *
 *  - ses: sent through Amazon SES with the process's AWS credentials. nodemailer builds the MIME
 *    message and SES sends it as-is, so attachments and inline images need no special handling.
 *  - smtp: sent through any SMTP server.
 *  - preview: nothing is sent; each email is kept as an .eml file staff can open, so the whole
 *    flow can be tested before credentials exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import nodemailer, { type SendMailOptions, type Transporter } from 'nodemailer';
import type { EmailMode } from '@shared/api';
import { COLORS, DOMAIN_COLORS } from '@shared/brand';
import { DISCLAIMER_FOOTER, DISCLAIMER_NOT_DIAGNOSTIC, ORG_NAME, orgAndCentre, PRODUCT_NAME } from '@shared/copy';
import { BAND_LABEL, DOMAIN_META, DOMAIN_ORDER, type BandKey, type DomainKey } from '@shared/domain';
import { formatDate } from '@shared/format';
import type { DomainStats } from '@shared/scoring';
import { ses } from '../aws';
import { config } from '../config';

export const emailMode: EmailMode = config.emailMode;

let transporter: Transporter | null = null;

/** SMTP when configured; otherwise a transport that only builds the message (CRLF for SES, LF for previews). */
function transport(): Transporter {
  transporter ??=
    emailMode === 'smtp' && config.smtp
      ? nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          auth: config.smtp.auth,
          // Fail within seconds rather than leaving staff waiting on an unreachable mail server.
          connectionTimeout: 15_000,
          greetingTimeout: 10_000,
          socketTimeout: 60_000,
        })
      : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: emailMode === 'ses' ? 'windows' : 'unix' });
  return transporter;
}

/** Logs (but doesn't fail start-up on) a sending problem, so it shows up before the first send. */
export async function verifyEmailTransport(): Promise<void> {
  if (emailMode === 'preview') return;
  try {
    if (emailMode === 'smtp') {
      await transport().verify();
      console.log(`[email] SMTP connection to ${config.smtp!.host} verified`);
    }
  } catch (error) {
    console.warn(`[email] SMTP verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ReportEmail {
  to: string;
  parentName: string;
  childFirstName: string;
  childFullName: string;
  centre: string;
  assessedAt: string;
  band: BandKey;
  overallPct: number;
  stats: DomainStats;
  focusDomains: DomainKey[];
  shareUrl: string;
  shareExpiresAt: string;
  personalMessage: string;
  senderName: string;
  pdf: Buffer;
  pdfFileName: string;
  /** The compass chart image, shown inline above the text scores (which still read without images). */
  chartImage: Buffer | null;
}

let logoPng: Buffer | null = null;
const logo = () => (logoPng ??= fs.readFileSync(path.join(config.assetsDir, 'brand', 'shichida-india-logo.png')));

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function reportEmailSubject(childFirstName: string): string {
  return `${childFirstName}’s ${PRODUCT_NAME} report from ${ORG_NAME}`;
}

function renderText(input: ReportEmail): string {
  const tz = config.timeZone;
  const lines = [
    `Dear ${input.parentName},`,
    '',
    `Thank you for bringing ${input.childFirstName} to ${orgAndCentre(input.centre)}. ${input.childFirstName}’s ${PRODUCT_NAME} report from the assessment on ${formatDate(input.assessedAt, tz, 'long')} is attached as a PDF.`,
  ];
  if (input.personalMessage) lines.push('', input.personalMessage, `— ${input.senderName}`);
  lines.push('', `Compass reading: ${Math.round(input.overallPct)}% of ${BAND_LABEL[input.band]} milestones observed`);
  for (const domain of DOMAIN_ORDER) {
    const stat = input.stats[domain];
    lines.push(`  ${DOMAIN_META[domain].name}: ${stat.done} of ${stat.total} (${Math.round(stat.pct)}%)`);
  }
  if (input.focusDomains.length) {
    lines.push('', `Suggested focus areas: ${input.focusDomains.map((d) => DOMAIN_META[d].short).join(', ')}. The report has play ideas for each.`);
  }
  lines.push(
    '',
    `View the report online (link valid until ${formatDate(input.shareExpiresAt, tz, 'long')}): ${input.shareUrl}`,
    '',
    `${DISCLAIMER_NOT_DIAGNOSTIC.title}. ${DISCLAIMER_NOT_DIAGNOSTIC.body}`,
    '',
    `Warm regards,`,
    `${input.senderName}`,
    ORG_NAME,
    ...contactLines(),
    '',
    DISCLAIMER_FOOTER,
  );
  return lines.join('\n');
}

function contactLines(): string[] {
  return [config.contact.phone, config.contact.email, config.contact.website].filter(Boolean);
}

function renderHtml(input: ReportEmail): string {
  const tz = config.timeZone;
  const font = `font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif`;
  const domainRows = DOMAIN_ORDER.map((domain) => {
    const stat = input.stats[domain];
    return `<tr>
      <td style="padding:8px 0;border-top:1px solid ${COLORS.line};${font};font-size:14px;color:${COLORS.ink};font-weight:600">
        <span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:${DOMAIN_COLORS[domain]};margin-right:8px;vertical-align:middle"></span>${DOMAIN_META[domain].name}
      </td>
      <td style="padding:8px 0;border-top:1px solid ${COLORS.line};${font};font-size:13px;color:${COLORS.muted};text-align:right">${stat.done} of ${stat.total}</td>
      <td style="padding:8px 0 8px 12px;border-top:1px solid ${COLORS.line};${font};font-size:14px;color:${COLORS.ink};font-weight:800;text-align:right;width:52px">${Math.round(stat.pct)}%</td>
    </tr>`;
  }).join('');
  const focus = input.focusDomains.length
    ? `<p style="margin:14px 0 0;${font};font-size:14px;line-height:1.55;color:${COLORS.ink2}">Suggested focus areas: <strong style="color:${COLORS.ink}">${input.focusDomains.map((d) => DOMAIN_META[d].short).join(', ')}</strong>. The report has play ideas to try at home for each.</p>`
    : '';
  const personal = input.personalMessage
    ? `<div style="margin:18px 0 0;padding:14px 16px;background:${COLORS.surface2};border-left:3px solid ${COLORS.brand};border-radius:8px;${font};font-size:14px;line-height:1.6;color:${COLORS.ink2};white-space:pre-line">${esc(input.personalMessage)}<br><span style="color:${COLORS.muted}">— ${esc(input.senderName)}</span></div>`
    : '';
  const chart = input.chartImage
    ? `<img src="cid:compass@early-compass" width="440" alt="${esc(input.childFirstName)}’s compass reading" style="display:block;width:100%;max-width:440px;height:auto;margin:0 auto 6px;border:0">`
    : '';
  return `<!doctype html>
<html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(reportEmailSubject(input.childFirstName))}</title></head>
<body style="margin:0;padding:0;background:${COLORS.paper}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${COLORS.paper}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:${COLORS.surface};border:1px solid ${COLORS.line};border-radius:18px;overflow:hidden">
  <tr><td style="height:5px;background:${COLORS.sun};line-height:5px;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:22px 28px 8px">
    <table role="presentation" cellspacing="0" cellpadding="0"><tr>
      <td style="padding-right:12px"><img src="cid:logo@early-compass" width="34" height="44" alt="Shichida India" style="display:block;border:0"></td>
      <td style="${font}"><div style="font-size:16px;font-weight:800;color:${COLORS.ink}">${ORG_NAME}</div><div style="font-size:13px;font-weight:600;color:${COLORS.muted}">${PRODUCT_NAME} report</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:10px 28px 4px;${font}">
    <p style="margin:0 0 12px;font-size:15px;color:${COLORS.ink}">Dear ${esc(input.parentName)},</p>
    <p style="margin:0;font-size:15px;line-height:1.6;color:${COLORS.ink2}">Thank you for bringing ${esc(input.childFirstName)} to ${esc(orgAndCentre(input.centre))}. ${esc(input.childFirstName)}’s ${PRODUCT_NAME} report from the assessment on <strong style="color:${COLORS.ink}">${formatDate(input.assessedAt, tz, 'long')}</strong> is attached as a PDF.</p>
    ${personal}
  </td></tr>
  <tr><td style="padding:18px 28px 0">
    <div style="border:1px solid ${COLORS.line};border-radius:14px;padding:18px 18px 10px">
      ${chart}
      <p style="margin:6px 0 4px;${font};font-size:15px;color:${COLORS.ink}"><strong style="font-size:26px;font-weight:800">${Math.round(input.overallPct)}%</strong> of ${BAND_LABEL[input.band]} milestones observed</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${domainRows}</table>
      ${focus}
    </div>
  </td></tr>
  <tr><td align="center" style="padding:22px 28px 6px">
    <a href="${esc(input.shareUrl)}" style="display:inline-block;background:${COLORS.brand};color:#ffffff;text-decoration:none;${font};font-size:15px;font-weight:700;padding:12px 26px;border-radius:12px">View the report online</a>
    <div style="${font};font-size:12px;color:${COLORS.muted};margin-top:8px">Link valid until ${formatDate(input.shareExpiresAt, tz, 'long')}</div>
  </td></tr>
  <tr><td style="padding:16px 28px 0">
    <div style="background:${COLORS.surface2};border:1px solid ${COLORS.lineStrong};border-radius:10px;padding:12px 14px;${font}">
      <div style="font-size:13px;font-weight:800;color:${COLORS.ink}">${DISCLAIMER_NOT_DIAGNOSTIC.title}</div>
      <div style="font-size:13px;line-height:1.55;color:${COLORS.ink2};margin-top:2px">${esc(DISCLAIMER_NOT_DIAGNOSTIC.body)}</div>
    </div>
  </td></tr>
  <tr><td style="padding:20px 28px 26px;${font};font-size:14px;line-height:1.6;color:${COLORS.ink2}">
    Warm regards,<br><strong style="color:${COLORS.ink}">${esc(input.senderName)}</strong><br>${ORG_NAME}${contactLines().length ? `<br><span style="color:${COLORS.muted};font-size:13px">${contactLines().map(esc).join(' · ')}</span>` : ''}
  </td></tr>
</table>
<p style="max-width:600px;margin:14px auto 0;${font};font-size:11.5px;line-height:1.5;color:${COLORS.muted};text-align:center">${esc(DISCLAIMER_FOOTER)}</p>
</td></tr></table>
</body></html>`;
}

/** Subject and both bodies, e.g. for previews. Inline images are referenced as cid:logo@… and cid:compass@…. */
export function renderReportEmail(input: ReportEmail): { subject: string; html: string; text: string } {
  return { subject: reportEmailSubject(input.childFirstName), html: renderHtml(input), text: renderText(input) };
}

export async function sendReportEmail(input: ReportEmail): Promise<{ messageId: string; previewEml: Buffer | null }> {
  const attachments: NonNullable<SendMailOptions['attachments']> = [
    { filename: input.pdfFileName, content: input.pdf, contentType: 'application/pdf' },
    { filename: 'shichida-india.png', content: logo(), contentType: 'image/png', cid: 'logo@early-compass' },
  ];
  if (input.chartImage) {
    attachments.push({ filename: 'compass.png', content: input.chartImage, contentType: 'image/png', cid: 'compass@early-compass' });
  }
  const info = await transport().sendMail({
    from: config.mailFrom,
    replyTo: config.mailReplyTo ?? undefined,
    to: input.to,
    subject: reportEmailSubject(input.childFirstName),
    text: renderText(input),
    html: renderHtml(input),
    attachments,
  });
  if (emailMode === 'ses') {
    if (!Buffer.isBuffer(info.message)) throw new Error('The email could not be composed');
    const sent = await ses().send(
      new SendEmailCommand({
        Destination: { ToAddresses: [input.to] },
        Content: { Raw: { Data: info.message } },
        ...(config.sesConfigurationSet ? { ConfigurationSetName: config.sesConfigurationSet } : {}),
      }),
    );
    return { messageId: sent.MessageId ?? '', previewEml: null };
  }
  const previewEml = emailMode === 'preview' && Buffer.isBuffer(info.message) ? info.message : null;
  return { messageId: String(info.messageId ?? ''), previewEml };
}
