/**
 * Recording an assessment. The server recomputes everything from the submitted answers
 * (age at the moment of saving, stats, target, focus areas, growth commentary) instead of
 * trusting the browser, snapshots the question wording and contact details into the record,
 * then renders the report files.
 */
import type { AssessmentDetail } from '../repo';
import type { ChildDTO } from '@shared/api';
import { itemsFromResponses } from '@shared/checklist';
import { DOMAIN_ORDER } from '@shared/domain';
import { ageInMonths, formatDate } from '@shared/format';
import { normalisePhone } from '@shared/phone';
import type { AssessmentSubmission, ChildDetails, ParentContact } from '@shared/schemas';
import { buildCommentary, evaluateAssessment, goalItems } from '@shared/scoring';
import { config } from '../config';
import { HttpError } from '../http';
import { assessments, checklist, children, parseAssessment, toChildDTO, toReadingSummary, type AssessmentRow, type UserRow } from '../repo';
import { generateReport, newShareWindow } from './reports';
import { syncAssessment, syncEnabled } from './sync';

/** The checklist is written for 0–6; allow children who have just turned 7. */
export const MAX_AGE_MONTHS = 95;

const invalid = (field: string, message: string) =>
  new HttpError(422, 'Please check the highlighted fields.', { [field]: message });

export async function createAssessment(input: AssessmentSubmission, user: UserRow): Promise<AssessmentRow> {
  const assessedAt = new Date();
  const phone = normalisePhone(input.parent.phone);
  if (!phone) throw invalid('parent.phone', 'Enter a valid 10-digit mobile number');

  const ageMonths = ageInMonths(input.child.dateOfBirth, assessedAt, config.timeZone);
  if (ageMonths === null) throw invalid('child.dateOfBirth', 'Date of birth cannot be in the future');
  if (ageMonths > MAX_AGE_MONTHS) throw invalid('child.dateOfBirth', 'The Early Compass covers children up to 7 years old');

  const band = input.band;
  const [items, checklistVersion] = await Promise.all([checklist.forBand(band), checklist.version()]);
  const known = new Set(DOMAIN_ORDER.flatMap((domain) => items[domain].map((item) => item.id)));
  const observed = new Set<string>();
  for (const id of input.observed) {
    if (!known.has(id)) {
      throw new HttpError(422, 'The checklist answers do not match the current checklist for this age band. Reload the page and try again.');
    }
    observed.add(id);
  }

  let goals: AssessmentDetail['goals'] = null;
  if (input.goals) {
    const items = goalItems(input.goals.age);
    const known = new Set(items.map((item) => item.id));
    const achieved = new Set(input.goals.achieved);
    if ([...achieved].some((id) => !known.has(id))) {
      throw new HttpError(422, 'The attainment goals do not match the selected age. Reload the page and try again.');
    }
    goals = { age: input.goals.age, items: items.map((item) => ({ ...item, achieved: achieved.has(item.id) })) };
  }

  const outcome = evaluateAssessment({
    band,
    items,
    ageMonths,
    observed,
    targetOverride: input.targetOverride,
    interests: input.interests,
  });
  const responses = DOMAIN_ORDER.flatMap((domain) =>
    items[domain].map((item) => ({ id: item.id, domain, text: item.text, observed: observed.has(item.id) })),
  );
  const parent = { ...input.parent, phone: phone.e164, email: input.parent.email.toLowerCase() };
  const assessedAtIso = assessedAt.toISOString();

  const existing = input.childId ? await children.byId(input.childId) : undefined;
  if (input.childId && !existing) throw new HttpError(404, 'That child record no longer exists. Start a new assessment.');
  const childRow = existing
    ? children.merge(existing, { child: input.child, parent })
    : children.build({ child: input.child, parent, userId: user.id });
  const previousRow = existing ? await assessments.latestForChild(existing.id) : undefined;
  const previous = previousRow ? toReadingSummary(previousRow) : null;
  const commentary = buildCommentary(
    { label: 'this assessment', date: assessedAtIso, band, stats: outcome.stats, overallPct: outcome.overallPct },
    previous
      ? {
          label: `the assessment on ${formatDate(previous.assessedAt, config.timeZone, 'long')}`,
          date: previous.assessedAt,
          band: previous.band,
          stats: previous.stats,
          overallPct: previous.overallPct,
        }
      : null,
  );
  const share = newShareWindow();
  const row = await assessments.create(
    {
      childId: childRow.id,
      assessedAt: assessedAtIso,
      ageMonths,
      band,
      bandOverridden: band !== bandForAge(ageMonths),
      checklistVersion,
      child: toChildDTO(childRow),
      responses,
      goals,
      interests: input.interests,
      stats: outcome.stats,
      overallPct: outcome.overallPct,
      autoTargetPct: outcome.autoTargetPct,
      targetPct: outcome.targetPct,
      targetIsCustom: outcome.targetIsCustom,
      focusAreas: outcome.focusAreas,
      commentary,
      previous,
      notes: input.notes,
      assessorId: user.id,
      assessorName: user.name,
      shareNonce: share.nonce,
      shareExpiresAt: share.expiresAt,
      syncStatus: syncEnabled ? 'pending' : 'disabled',
    },
    { row: childRow, isNew: !existing },
  );

  try {
    await generateReport(row.id);
  } catch (error) {
    // The answers are safe in the record; the error is stored on it and staff can retry generation.
    console.error(`[report] ${row.reference}: generation failed`, error);
  }
  const saved = (await assessments.byId(row.id))!;
  if (syncEnabled && saved.report_version > 0) void syncAssessment(saved.id);
  return saved;
}

/**
 * Corrects the child's and parent's details from one assessment. The child record is updated, this
 * assessment's snapshot and age-based results (age, target, focus areas) are recomputed, and a new
 * report version is rendered. Earlier versions, which may already have been sent, are kept.
 */
export async function updateAssessmentDetails(row: AssessmentRow, input: { child: ChildDetails; parent: ParentContact }): Promise<AssessmentRow> {
  const phone = normalisePhone(input.parent.phone);
  if (!phone) throw invalid('parent.phone', 'Enter a valid 10-digit mobile number');
  const ageMonths = ageInMonths(input.child.dateOfBirth, new Date(row.assessed_at), config.timeZone);
  if (ageMonths === null) throw invalid('child.dateOfBirth', 'Date of birth must be before the assessment date');
  if (ageMonths > MAX_AGE_MONTHS) throw invalid('child.dateOfBirth', 'The Early Compass covers children up to 7 years old');

  const detail = parseAssessment(row);
  const outcome = evaluateAssessment({
    band: row.band,
    items: itemsFromResponses(detail.responses),
    ageMonths,
    observed: new Set(detail.responses.filter((response) => response.observed).map((response) => response.id)),
    targetOverride: row.target_is_custom ? row.target_pct : null,
    interests: detail.interests,
  });
  const parent = { ...input.parent, phone: phone.e164, email: input.parent.email.toLowerCase() };

  const updatedChild = await children.update(row.child_id, { child: input.child, parent });
  if (!updatedChild) throw new HttpError(404, 'That child record no longer exists.');
  const child = toChildDTO(updatedChild);
  // Compared with this assessment's snapshot, so an edit that was saved to the child but not yet
  // to the assessment (a failed request) is completed by trying again.
  if (detailsKey(child) === detailsKey(detail.child)) return (await assessments.byId(row.id)) ?? row;
  await assessments.updateDetails(row.id, {
    child,
    ageMonths,
    bandOverridden: row.band !== bandForAge(ageMonths),
    autoTargetPct: outcome.autoTargetPct,
    targetPct: outcome.targetPct,
    focusAreas: outcome.focusAreas,
  });

  try {
    await generateReport(row.id);
  } catch (error) {
    // The corrected details are saved; the error is stored on the record and staff can retry generation.
    console.error(`[report] ${row.reference}: generation failed after editing details`, error);
  }
  const saved = (await assessments.byId(row.id))!;
  if (syncEnabled && saved.report_version > 0 && saved.sync_status !== 'synced') void syncAssessment(saved.id);
  return saved;
}

/** The details a report shows, for telling whether an edit changed anything. */
function detailsKey({ firstName, lastName, dateOfBirth, gender, centre, parent }: ChildDTO): string {
  return JSON.stringify([firstName, lastName, dateOfBirth, gender, centre, parent.name, parent.relation, parent.phone, parent.email]);
}

function bandForAge(ageMonths: number) {
  return ageMonths < 24 ? '0-2' : ageMonths < 48 ? '2-4' : '4-6';
}
