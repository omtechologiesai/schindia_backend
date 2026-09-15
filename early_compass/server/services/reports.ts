/**
 * Turns a stored assessment into files: the compass chart, the shareable snapshot card and
 * the PDF. Also owns parent share links and the assessment view model.
 */
import type { AssessmentDTO } from '@shared/api';
import { DOMAIN_ORDER, type DomainKey } from '@shared/domain';
import { formatAge, formatDate, todayISO } from '@shared/format';
import type { DomainStats } from '@shared/scoring';
import { config } from '../config';
import { assessments, deliveries, parseAssessment, toDeliveryDTO, type AssessmentDetail, type AssessmentRow } from '../repo';
import { isValidShareSignature, parseShareToken, randomToken, shareToken } from '../security';
import { files, reportKey, type ReportFileKind } from '../storage';
import { renderChartPng, renderSnapshotPng } from './chart';
import { renderReportPdf } from './report-pdf';

const DAY_MS = 86_400_000;

const pctByDomain = (stats: DomainStats) =>
  Object.fromEntries(DOMAIN_ORDER.map((domain) => [domain, stats[domain].pct])) as Record<DomainKey, number>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "Early-Compass_Aarav-Sharma_2026-09-15.pdf" (ASCII only, safe for every mail client and WhatsApp). */
export function reportFileName(row: AssessmentRow, detail: AssessmentDetail = parseAssessment(row)): string {
  const safe = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'Child';
  const day = todayISO(config.timeZone, new Date(row.assessed_at));
  return `Early-Compass_${safe(detail.child.firstName)}-${safe(detail.child.lastName)}_${day}.pdf`;
}

/** Renders the next report version and records it. On failure the error is stored on the record and rethrown. */
export async function generateReport(assessmentId: string): Promise<AssessmentRow> {
  const row = await assessments.byId(assessmentId);
  if (!row) throw new Error(`Assessment ${assessmentId} not found`);
  const detail = parseAssessment(row);
  const version = row.report_version + 1;
  try {
    const comparable = detail.previous && detail.previous.band === row.band ? detail.previous : null;
    const chartParts = {
      pct: pctByDomain(detail.stats),
      targetPct: row.target_pct,
      previousPct: comparable ? pctByDomain(comparable.stats) : null,
    };
    const chartPng = renderChartPng(chartParts);
    const snapshotPng = renderSnapshotPng({
      ...chartParts,
      childName: detail.child.firstName,
      band: row.band,
      ageText: formatAge(row.age_months),
      dateText: formatDate(row.assessed_at, config.timeZone),
      reference: row.reference,
      overallPct: row.overall_pct,
      stats: detail.stats,
      previousLabel: comparable ? 'Previous assessment' : null,
    });
    const pdf = await renderReportPdf({
      reference: row.reference,
      assessedAt: row.assessed_at,
      generatedAt: new Date().toISOString(),
      timeZone: config.timeZone,
      child: detail.child,
      ageMonths: row.age_months,
      band: row.band,
      bandOverridden: row.band_overridden === 1,
      checklistVersion: row.checklist_version,
      assessorName: row.assessor_name,
      stats: detail.stats,
      overallPct: row.overall_pct,
      autoTargetPct: row.auto_target_pct,
      targetPct: row.target_pct,
      targetIsCustom: row.target_is_custom === 1,
      focusAreas: detail.focusAreas,
      commentary: detail.commentary,
      previous: detail.previous,
      previousComparable: comparable !== null,
      responses: detail.responses,
      goals: detail.goals,
      interests: detail.interests,
      notes: row.notes,
      chartPng,
      contact: config.contact,
    });
    await files.put(reportKey(row.id, version, 'chart'), chartPng, 'image/png');
    await files.put(reportKey(row.id, version, 'snapshot'), snapshotPng, 'image/png');
    await files.put(reportKey(row.id, version, 'pdf'), pdf, 'application/pdf');
    await assessments.recordReport(row.id, version);
  } catch (error) {
    await assessments.recordReportError(row.id, errorMessage(error));
    throw error;
  }
  return (await assessments.byId(row.id))!;
}

export async function readReportFile(row: AssessmentRow, kind: ReportFileKind): Promise<Buffer | null> {
  if (row.report_version < 1) return null;
  return files.get(reportKey(row.id, row.report_version, kind));
}

/* ---------------------------------------------------------- share links */

export function newShareWindow(): { nonce: string; expiresAt: string } {
  return { nonce: randomToken(12), expiresAt: new Date(Date.now() + config.reportLinkDays * DAY_MS).toISOString() };
}

export function shareUrl(row: AssessmentRow): string {
  return `${config.publicBaseUrl}${config.basePath}/r/${shareToken(row.id, row.share_nonce, row.share_expires_at)}`;
}

/** Before sending, renew a link that has expired or would expire within a week. */
export async function ensureShareLink(row: AssessmentRow): Promise<AssessmentRow> {
  if (Date.parse(row.share_expires_at) - Date.now() > 7 * DAY_MS) return row;
  const { nonce, expiresAt } = newShareWindow();
  await assessments.rotateShare(row.id, nonce, expiresAt);
  return (await assessments.byId(row.id))!;
}

/** Revokes every link sent so far and issues a fresh one. */
export async function revokeShareLinks(row: AssessmentRow): Promise<AssessmentRow> {
  const { nonce, expiresAt } = newShareWindow();
  await assessments.rotateShare(row.id, nonce, expiresAt);
  return (await assessments.byId(row.id))!;
}

export async function resolveShareToken(token: string): Promise<AssessmentRow | null> {
  const parsed = parseShareToken(token);
  if (!parsed) return null;
  const row = await assessments.byId(parsed.assessmentId);
  if (!row || Date.parse(row.share_expires_at) <= Date.now()) return null;
  return isValidShareSignature(row.id, parsed.signature, row.share_nonce, row.share_expires_at) ? row : null;
}

/* ----------------------------------------------------------- view model */

export async function toAssessmentDTO(row: AssessmentRow): Promise<AssessmentDTO> {
  const detail = parseAssessment(row);
  const fileUrl = (name: string) => `${config.basePath}/api/assessments/${row.id}/${name}?v=${row.report_version}`;
  return {
    id: row.id,
    reference: row.reference,
    assessedAt: row.assessed_at,
    ageMonths: row.age_months,
    band: row.band,
    bandOverridden: row.band_overridden === 1,
    checklistVersion: row.checklist_version,
    child: detail.child,
    responses: detail.responses,
    goals: detail.goals,
    interests: detail.interests,
    stats: detail.stats,
    overallPct: row.overall_pct,
    autoTargetPct: row.auto_target_pct,
    targetPct: row.target_pct,
    targetIsCustom: row.target_is_custom === 1,
    focusAreas: detail.focusAreas,
    commentary: detail.commentary,
    previous: detail.previous,
    notes: row.notes,
    assessor: { id: row.assessor_id, name: row.assessor_name },
    report: {
      version: row.report_version,
      generatedAt: row.report_generated_at,
      error: row.report_error,
      fileName: reportFileName(row, detail),
      pdfUrl: fileUrl('report.pdf'),
      chartUrl: fileUrl('chart.png'),
      snapshotUrl: fileUrl('snapshot.png'),
    },
    share: { url: shareUrl(row), expiresAt: row.share_expires_at },
    deliveries: (await deliveries.forAssessment(row.id)).map(toDeliveryDTO),
    sync: { status: row.sync_status, attempts: row.sync_attempts, error: row.sync_error, syncedAt: row.synced_at },
    createdAt: row.created_at,
  };
}
