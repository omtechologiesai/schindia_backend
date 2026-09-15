/**
 * Pushes each finished assessment into Shichida India's internal system: child details,
 * parent contact, every answer, the scores and the PDF itself (base64), as one signed JSON
 * POST to INTERNAL_WEBHOOK_URL.
 *
 * The receiver should verify X-EarlyCompass-Signature (sha256 HMAC of the raw body with
 * INTERNAL_WEBHOOK_SECRET) and treat assessment.id as an idempotency key, because a failed
 * delivery is retried with backoff (up to MAX_ATTEMPTS times).
 */
import { BAND_LABEL } from '@shared/domain';
import { config } from '../config';
import { assessments, parseAssessment } from '../repo';
import { hmacSha256Hex } from '../security';
import { errorMessage, readReportFile, reportFileName, shareUrl } from './reports';

export const syncEnabled = config.webhook !== null;
const MAX_ATTEMPTS = 6;
const inFlight = new Set<string>();

export async function syncAssessment(assessmentId: string): Promise<void> {
  const webhook = config.webhook;
  if (!webhook || inFlight.has(assessmentId)) return;
  inFlight.add(assessmentId);
  const row = await assessments.byId(assessmentId);
  if (!row || row.report_version < 1) {
    inFlight.delete(assessmentId);
    return;
  }
  const attempts = row.sync_attempts + 1;
  try {
    const detail = parseAssessment(row);
    const pdf = await readReportFile(row, 'pdf');
    const body = JSON.stringify({
      event: 'assessment.report_ready',
      sentAt: new Date().toISOString(),
      assessment: {
        id: row.id,
        reference: row.reference,
        assessedAt: row.assessed_at,
        ageMonths: row.age_months,
        band: row.band,
        bandLabel: BAND_LABEL[row.band],
        checklistVersion: row.checklist_version,
        overallPct: Math.round(row.overall_pct * 10) / 10,
        targetPct: row.target_pct,
        stats: detail.stats,
        focusAreas: detail.focusAreas.map(({ domain, pct, gap }) => ({ domain, pct, gap })),
        responses: detail.responses,
        goals: detail.goals,
        interests: detail.interests,
        notes: row.notes,
        assessorName: row.assessor_name,
      },
      child: {
        id: row.child_id,
        firstName: detail.child.firstName,
        lastName: detail.child.lastName,
        dateOfBirth: detail.child.dateOfBirth,
        gender: detail.child.gender,
        centre: detail.child.centre,
      },
      parent: detail.child.parent,
      report: {
        version: row.report_version,
        fileName: reportFileName(row, detail),
        contentType: 'application/pdf',
        pdfBase64: pdf ? pdf.toString('base64') : null,
        shareUrl: shareUrl(row),
        shareExpiresAt: row.share_expires_at,
      },
    });
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-EarlyCompass-Event': 'assessment.report_ready',
        'X-EarlyCompass-Delivery': `${row.id}:${attempts}`,
        'X-EarlyCompass-Signature': `sha256=${hmacSha256Hex(webhook.secret, body)}`,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Internal system responded with HTTP ${response.status}`);
    await assessments.recordSync(row.id, { status: 'synced', attempts, error: null, syncedAt: new Date().toISOString() });
  } catch (error) {
    await assessments.recordSync(row.id, { status: 'failed', attempts, error: errorMessage(error), syncedAt: null }).catch(() => {});
    console.warn(`[sync] ${row.reference} attempt ${attempts} failed: ${errorMessage(error)}`);
  } finally {
    inFlight.delete(assessmentId);
  }
}

/** Retries pending and failed syncs once a minute, backing off 2^attempts minutes between tries. */
export function startSyncRetryLoop(): void {
  if (!syncEnabled) return;
  const timer = setInterval(() => {
    void (async () => {
      for (const row of await assessments.unsynced(MAX_ATTEMPTS)) {
        const waitMs = row.sync_status === 'pending' ? 0 : 2 ** row.sync_attempts * 60_000;
        if (Date.now() - Date.parse(row.updated_at) >= waitMs) void syncAssessment(row.id);
      }
    })().catch((error) => console.warn(`[sync] retry sweep failed: ${errorMessage(error)}`));
  }, 60_000);
  timer.unref();
}
