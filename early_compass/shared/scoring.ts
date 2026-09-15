/**
 * The Early Compass algorithm, ported from the Shape Early Compass without changing its
 * behaviour: band from age, per-domain attainment, the age-based target, focus areas,
 * activity suggestions and growth commentary. The client uses it for the live preview;
 * the server re-runs it on submit so stored records never trust client arithmetic.
 */
import { ACTIVITIES, type Activity, type InterestKey } from './data/activities';
import type { BandItems, ChecklistItem } from './checklist';
import { GOALS, type GoalAge } from './data/goals';
import { BAND_BOUNDS, BAND_LABEL, DOMAIN_META, DOMAIN_ORDER, type BandKey, type DomainKey } from './domain';

export interface DomainStat {
  done: number;
  total: number;
  pct: number;
}

export type DomainStats = Record<DomainKey, DomainStat>;

/** Under 24 months → 0–2, under 48 → 2–4, otherwise 4–6. Unknown age falls back to 0–2. */
export function bandForMonths(ageMonths: number | null | undefined): BandKey {
  if (ageMonths == null) return '0-2';
  if (ageMonths < 24) return '0-2';
  if (ageMonths < 48) return '2-4';
  return '4-6';
}

export function computeStats(items: BandItems, observed: ReadonlySet<string>): DomainStats {
  const stats = {} as DomainStats;
  for (const domain of DOMAIN_ORDER) {
    const list = items[domain];
    const done = list.filter((item) => observed.has(item.id)).length;
    stats[domain] = { done, total: list.length, pct: list.length ? (done / list.length) * 100 : 0 };
  }
  return stats;
}

/** Share of all milestones in the band that were observed (item-weighted, as in the original). */
export function overallPct(stats: DomainStats): number {
  let done = 0;
  let total = 0;
  for (const domain of DOMAIN_ORDER) {
    done += stats[domain].done;
    total += stats[domain].total;
  }
  return total ? (done / total) * 100 : 0;
}

/**
 * Where a child "should" be within the band, assuming roughly linear milestone pace across
 * it. A sensible default attainment target that staff can override (10–95%, steps of 5).
 */
export function expectedPctForAge(ageMonths: number | null | undefined, band: BandKey): number {
  if (ageMonths == null) return 50;
  const [lo, hi] = BAND_BOUNDS[band];
  const pct = ((ageMonths - lo) / (hi - lo)) * 100;
  return Math.round(Math.min(100, Math.max(5, pct)));
}

export const TARGET_MIN = 10;
export const TARGET_MAX = 95;
export const TARGET_STEP = 5;

/** A domain counts as a focus area once it sits more than this many points below target. */
export const FOCUS_GAP_POINTS = 4;

export interface FocusArea {
  domain: DomainKey;
  pct: number;
  gap: number;
}

export function rankFocusAreas(stats: DomainStats, target: number): FocusArea[] {
  return DOMAIN_ORDER.map((domain) => ({ domain, pct: stats[domain].pct, gap: target - stats[domain].pct }))
    .filter((area) => area.gap > FOCUS_GAP_POINTS)
    .sort((a, b) => b.gap - a.gap);
}

/** The first milestones in checklist order that have not been observed yet. */
export function nextMilestones(items: readonly ChecklistItem[], observed: ReadonlySet<string>, limit = 3): string[] {
  return items
    .filter((item) => !observed.has(item.id))
    .slice(0, limit)
    .map((item) => item.text);
}

/** Activities matching the child's interests come first; the rest keep their curated order. */
export function pickActivities(domain: DomainKey, band: BandKey, interests: readonly InterestKey[]): Activity[] {
  const list = ACTIVITIES[`${domain}|${band}`] ?? [];
  if (interests.length === 0) return [...list];
  const matches = list.filter((activity) => activity.tags.some((tag) => interests.includes(tag)));
  const rest = list.filter((activity) => !matches.includes(activity));
  return [...matches, ...rest];
}

export interface FocusAreaDetail extends FocusArea {
  activities: Activity[];
  nextMilestones: string[];
}

export interface AssessmentOutcome {
  stats: DomainStats;
  overallPct: number;
  autoTargetPct: number;
  targetPct: number;
  targetIsCustom: boolean;
  focusAreas: FocusAreaDetail[];
}

export function evaluateAssessment(input: {
  band: BandKey;
  /** The band's questions: the live checklist, or the ones a saved assessment was answered against. */
  items: BandItems;
  ageMonths: number | null;
  observed: ReadonlySet<string>;
  targetOverride: number | null;
  interests: readonly InterestKey[];
}): AssessmentOutcome {
  const stats = computeStats(input.items, input.observed);
  const autoTargetPct = expectedPctForAge(input.ageMonths, input.band);
  const targetPct = input.targetOverride ?? autoTargetPct;
  const focusAreas = rankFocusAreas(stats, targetPct).map((area) => ({
    ...area,
    activities: pickActivities(area.domain, input.band, input.interests).slice(0, 3),
    nextMilestones: nextMilestones(input.items[area.domain], input.observed, 3),
  }));
  return {
    stats,
    overallPct: overallPct(stats),
    autoTargetPct,
    targetPct,
    targetIsCustom: input.targetOverride != null,
    focusAreas,
  };
}

/* ---------- growth commentary between two assessments ---------- */

export interface Reading {
  /** How the reading is referred to in a sentence, e.g. "the assessment on 12 Jun 2026". */
  label: string;
  date: string;
  band: BandKey;
  stats: DomainStats;
  overallPct: number;
}

export interface DomainDelta {
  domain: DomainKey;
  delta: number;
  pct: number;
}

export interface Commentary {
  narrative: string;
  deltas: DomainDelta[] | null;
  bandChanged: boolean;
  days: number | null;
  overallDelta: number | null;
}

export function buildCommentary(curr: Reading, prev: Reading | null): Commentary {
  if (!prev) {
    return {
      narrative:
        'This is the first assessment on record, so there is no earlier reading to compare against yet. Growth commentary will appear here after the next assessment.',
      deltas: null,
      bandChanged: false,
      days: null,
      overallDelta: null,
    };
  }
  const days = Math.max(0, Math.round((new Date(curr.date).getTime() - new Date(prev.date).getTime()) / 86_400_000));
  const dayWord = `${days} day${days === 1 ? '' : 's'}`;
  if (curr.band !== prev.band) {
    return {
      narrative: `Since ${prev.label} (${dayWord} earlier), the tracked age band moved from ${BAND_LABEL[prev.band]} to ${BAND_LABEL[curr.band]}, so this assessment covers a different set of milestones than the last one. Current overall attainment: ${Math.round(curr.overallPct)}%.`,
      deltas: null,
      bandChanged: true,
      days,
      overallDelta: null,
    };
  }
  const overallDelta = curr.overallPct - prev.overallPct;
  const deltas = DOMAIN_ORDER.map((domain) => ({
    domain,
    delta: curr.stats[domain].pct - prev.stats[domain].pct,
    pct: curr.stats[domain].pct,
  }));
  const sorted = [...deltas].sort((a, b) => b.delta - a.delta);
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;
  const sign = (n: number) => (n >= 0 ? '+' : '');
  const short = (domain: DomainKey) => DOMAIN_META[domain].short;

  let narrative = `Since ${prev.label} (${dayWord} earlier), overall attainment moved from ${Math.round(prev.overallPct)}% to ${Math.round(curr.overallPct)}% (${sign(overallDelta)}${Math.round(overallDelta)} pts).`;
  if (best.delta > 0.5) narrative += ` ${short(best.domain)} grew the most (${sign(best.delta)}${Math.round(best.delta)} pts).`;
  if (worst.delta < -0.5) {
    narrative += ` ${short(worst.domain)} dipped ${Math.round(Math.abs(worst.delta))} pts — often just an earlier check being corrected, but worth a look.`;
  } else if (worst.domain !== best.domain) {
    narrative += ` ${short(worst.domain)} grew the least (${sign(worst.delta)}${Math.round(worst.delta)} pts) and may be worth extra focus.`;
  }
  return { narrative, deltas, bandChanged: false, days, overallDelta };
}

/* ---------- attainment goals ---------- */

/** The goals year shown for a child: whole years of age, clamped to the 0–6 framework. */
export function goalAgeForMonths(ageMonths: number | null | undefined): GoalAge {
  const years = ageMonths == null ? 0 : Math.floor(ageMonths / 12);
  return String(Math.min(6, Math.max(0, years))) as GoalAge;
}

export function goalId(age: GoalAge, category: string, index: number): string {
  return `${age}|${category}|${index + 1}`;
}

export function goalItems(age: GoalAge): { id: string; category: string; text: string }[] {
  return Object.entries(GOALS[age]).flatMap(([category, items]) =>
    items.map((text, i) => ({ id: goalId(age, category, i), category, text })),
  );
}
