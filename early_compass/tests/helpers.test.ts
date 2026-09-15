import { describe, expect, it } from 'vitest';
import { compassGeometry, escapeXml, labelLayout, renderCompassSvg } from '@shared/compass';
import { ageInMonths, formatAge, formatCalendarDate, formatDateTime, parseISODate } from '@shared/format';
import { formatPhone, normalisePhone } from '@shared/phone';

describe('ageInMonths', () => {
  it('counts completed months in the given time zone', () => {
    // 20:00 UTC on 14 Sep is already 15 Sep in India: the third birthday has arrived there.
    expect(ageInMonths('2023-09-15', new Date('2026-09-14T20:00:00Z'), 'Asia/Kolkata')).toBe(36);
    expect(ageInMonths('2023-09-15', new Date('2026-09-14T20:00:00Z'), 'UTC')).toBe(35);
  });

  it('handles month ends and future dates', () => {
    expect(ageInMonths('2024-01-31', new Date('2024-02-29T12:00:00Z'), 'Asia/Kolkata')).toBe(0);
    expect(ageInMonths('2024-01-31', new Date('2024-03-31T12:00:00Z'), 'Asia/Kolkata')).toBe(2);
    expect(ageInMonths('2030-01-01', new Date('2026-01-01T00:00:00Z'), 'Asia/Kolkata')).toBeNull();
    expect(ageInMonths('not-a-date', new Date(), 'Asia/Kolkata')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats ages', () => {
    expect(formatAge(38)).toBe('3 yr 2 mo');
    expect(formatAge(8)).toBe('8 mo');
    expect(formatAge(38, 'long')).toBe('3 years 2 months');
    expect(formatAge(12, 'long')).toBe('1 year');
    expect(formatAge(1, 'long')).toBe('1 month');
  });

  it('formats dates and times in IST identically on every runtime', () => {
    expect(formatDateTime('2026-09-15T10:15:00Z', 'Asia/Kolkata')).toBe('15 Sep 2026, 3:45 pm IST');
    expect(formatDateTime('2026-09-14T18:40:00Z', 'Asia/Kolkata')).toBe('15 Sep 2026, 12:10 am IST');
    expect(formatCalendarDate('2024-03-05', 'long')).toBe('5 March 2024');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseISODate('2025-02-30')).toBeNull();
    expect(parseISODate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
  });
});

describe('normalisePhone', () => {
  it('accepts the ways Indian mobile numbers are usually written', () => {
    for (const raw of ['98765 43210', '+91 98765-43210', '09876543210', '919876543210', '0091 9876543210', '(+91) 98765.43210']) {
      expect(normalisePhone(raw)?.e164, raw).toBe('+919876543210');
    }
    expect(normalisePhone('9876543210')?.digits).toBe('919876543210');
  });

  it('rejects landline-like or malformed numbers', () => {
    for (const raw of ['12345', '5876543210', '+91 12345 67890', 'call me', '']) {
      expect(normalisePhone(raw), raw).toBeNull();
    }
  });

  it('keeps other countries when written with a + prefix', () => {
    expect(normalisePhone('+44 20 7946 0958')?.e164).toBe('+442079460958');
  });

  it('formats Indian numbers for display', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
    expect(formatPhone('+442079460958')).toBe('+442079460958');
  });
});

describe('compass geometry', () => {
  it('draws a full reading on the outer ring and the target as its own diamond', () => {
    const g = compassGeometry({ pct: { physical: 100, sensory: 100, language: 100, social: 100 }, targetPct: 50 });
    expect(g.shape).toBe(g.rings[3]);
    expect(g.target).toBe(g.rings[1]);
    expect(g.axes.map((a) => a.label.anchor)).toEqual(['middle', 'start', 'middle', 'end']);
  });

  it('keeps labels inside the layout box', () => {
    const g = compassGeometry({ pct: { physical: 10, sensory: 90, language: 50, social: 0 } });
    for (const axis of g.axes) {
      const layout = labelLayout(axis);
      expect(layout.dot[0]).toBeGreaterThan(0);
      expect(layout.dot[0]).toBeLessThan(g.width);
      expect(layout.eyebrowAt[1]).toBeGreaterThan(0);
      expect(layout.valueAt[1]).toBeLessThan(g.height);
    }
  });

  it('renders valid SVG with escaped text', () => {
    const svg = renderCompassSvg({ pct: { physical: 62.4, sensory: 50, language: 33, social: 80 }, targetPct: 55, previousPct: null });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('>62%<');
    expect(svg).toContain('stroke-dasharray="5 4"');
    expect(escapeXml(`<Aarav & "Meera">`)).toBe('&lt;Aarav &amp; &quot;Meera&quot;&gt;');
  });
});
