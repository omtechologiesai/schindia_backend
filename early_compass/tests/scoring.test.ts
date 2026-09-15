/** The algorithm must behave exactly like the Shape Early Compass it was ported from. */
import { describe, expect, it } from 'vitest';
import { seedChecklist } from '@shared/checklist';
import { CHECKLIST } from '@shared/data/checklist';
import { DOMAIN_ORDER, itemId, type DomainKey } from '@shared/domain';
import {
  bandForMonths,
  buildCommentary,
  computeStats,
  evaluateAssessment,
  expectedPctForAge,
  overallPct,
  pickActivities,
  rankFocusAreas,
  type DomainStats,
} from '@shared/scoring';

const statsFrom = (pcts: Record<DomainKey, number>): DomainStats =>
  Object.fromEntries(DOMAIN_ORDER.map((d) => [d, { done: 0, total: 36, pct: pcts[d] }])) as DomainStats;

/** The original checklist, as the database is seeded with it. */
const SEED = seedChecklist();

describe('checklist data', () => {
  it('has all 480 items: 48 per domain for 0–2, 36 for 2–4 and 4–6', () => {
    const count = (band: '0-2' | '2-4' | '4-6') => DOMAIN_ORDER.map((d) => CHECKLIST[band][d].length);
    expect(count('0-2')).toEqual([48, 48, 48, 48]);
    expect(count('2-4')).toEqual([36, 36, 36, 36]);
    expect(count('4-6')).toEqual([36, 36, 36, 36]);
  });
});

describe('bandForMonths', () => {
  it('uses the original band boundaries', () => {
    expect(bandForMonths(null)).toBe('0-2');
    expect(bandForMonths(0)).toBe('0-2');
    expect(bandForMonths(23)).toBe('0-2');
    expect(bandForMonths(24)).toBe('2-4');
    expect(bandForMonths(47)).toBe('2-4');
    expect(bandForMonths(48)).toBe('4-6');
    expect(bandForMonths(90)).toBe('4-6');
  });
});

describe('expectedPctForAge', () => {
  it('assumes a linear pace through the band, clamped to 5–100', () => {
    expect(expectedPctForAge(null, '2-4')).toBe(50);
    expect(expectedPctForAge(24, '2-4')).toBe(5);
    expect(expectedPctForAge(36, '2-4')).toBe(50);
    expect(expectedPctForAge(46, '2-4')).toBe(92);
    expect(expectedPctForAge(80, '4-6')).toBe(100);
    expect(expectedPctForAge(10, '4-6')).toBe(5);
  });
});

describe('computeStats and overallPct', () => {
  it('counts observed items per domain within the band only', () => {
    const observed = new Set([
      ...Array.from({ length: 12 }, (_, i) => itemId('0-2', 'physical', i)),
      itemId('2-4', 'sensory', 0), // a different band: must be ignored
    ]);
    const stats = computeStats(SEED['0-2'], observed);
    expect(stats.physical).toEqual({ done: 12, total: 48, pct: 25 });
    expect(stats.sensory).toEqual({ done: 0, total: 48, pct: 0 });
    expect(overallPct(stats)).toBe(6.25);
  });
});

describe('rankFocusAreas', () => {
  it('keeps domains more than 4 points below target, largest gap first', () => {
    const areas = rankFocusAreas(statsFrom({ physical: 25, sensory: 60, language: 48, social: 50 }), 55);
    expect(areas.map((a) => [a.domain, a.gap])).toEqual([
      ['physical', 30],
      ['language', 7],
      ['social', 5],
    ]);
  });

  it('treats a gap of exactly 4 points as on target', () => {
    expect(rankFocusAreas(statsFrom({ physical: 51, sensory: 51, language: 51, social: 51 }), 55)).toEqual([]);
  });
});

describe('pickActivities', () => {
  it('moves activities matching the interests to the front and keeps the rest in order', () => {
    const all = pickActivities('physical', '0-2', []);
    expect(pickActivities('physical', '0-2', ['books'])).toEqual(all);
    const building = pickActivities('physical', '0-2', ['building']);
    expect(building[0]).toBe(all[1]);
    expect(building.slice(1)).toEqual([all[0], all[2], all[3]]);
  });
});

describe('evaluateAssessment', () => {
  it('uses the override target when set and attaches three ideas and next milestones per focus area', () => {
    const outcome = evaluateAssessment({ band: '2-4', items: SEED['2-4'], ageMonths: 36, observed: new Set(), targetOverride: 30, interests: [] });
    expect(outcome.autoTargetPct).toBe(50);
    expect(outcome.targetPct).toBe(30);
    expect(outcome.targetIsCustom).toBe(true);
    expect(outcome.focusAreas).toHaveLength(4);
    expect(outcome.focusAreas[0]!.activities).toHaveLength(3);
    expect(outcome.focusAreas[0]!.nextMilestones).toEqual(CHECKLIST['2-4'][outcome.focusAreas[0]!.domain].slice(0, 3));
  });
});

describe('buildCommentary', () => {
  const prev = {
    label: 'the assessment on 12 June 2026',
    date: '2026-06-12T10:00:00.000Z',
    band: '2-4' as const,
    stats: statsFrom({ physical: 40, sensory: 40, language: 40, social: 40 }),
    overallPct: 40,
  };

  it('explains the first assessment', () => {
    const c = buildCommentary({ ...prev, label: 'this assessment' }, null);
    expect(c.deltas).toBeNull();
    expect(c.narrative).toMatch(/^This is the first assessment on record/);
  });

  it('describes overall movement, the biggest gain and the smallest', () => {
    const c = buildCommentary(
      { label: 'this assessment', date: '2026-09-12T10:00:00.000Z', band: '2-4', stats: statsFrom({ physical: 55, sensory: 55, language: 60, social: 45 }), overallPct: 55 },
      prev,
    );
    expect(c.days).toBe(92);
    expect(c.narrative).toBe(
      'Since the assessment on 12 June 2026 (92 days earlier), overall attainment moved from 40% to 55% (+15 pts). Language grew the most (+20 pts). Social grew the least (+5 pts) and may be worth extra focus.',
    );
  });

  it('flags a dip as probably a corrected earlier check', () => {
    const c = buildCommentary(
      { label: 'this assessment', date: '2026-06-13T10:00:00.000Z', band: '2-4', stats: statsFrom({ physical: 50, sensory: 40, language: 40, social: 30 }), overallPct: 40 },
      prev,
    );
    expect(c.narrative).toContain('1 day earlier');
    expect(c.narrative).toContain('Social dipped 10 pts — often just an earlier check being corrected, but worth a look.');
  });

  it('does not compare percentages across a band change', () => {
    const c = buildCommentary({ ...prev, band: '4-6', date: '2027-06-12T10:00:00.000Z', overallPct: 20 }, prev);
    expect(c.bandChanged).toBe(true);
    expect(c.deltas).toBeNull();
    expect(c.narrative).toContain('moved from 2–4 years to 4–6 years');
  });
});
