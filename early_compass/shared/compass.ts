/**
 * The compass chart: four axes (N Physical, E Sensory, S Language, W Social), the child's
 * reading as a filled shape, the age-based target as a dashed diamond and, for follow-ups,
 * the previous reading as a grey outline.
 *
 * compassGeometry() and labelLayout() are the single source of truth for positions. The
 * portal renders them as interactive React SVG; renderCompassSvg() renders the same geometry
 * as an SVG string that the server rasterises for the PDF and the shareable snapshot.
 */
import { COLORS, DOMAIN_COLORS, FONT_FAMILY } from './brand';
import { BAND_LABEL, DOMAIN_META, DOMAIN_ORDER, type BandKey, type DomainKey } from './domain';

export type Point = readonly [number, number];

export interface CompassAxis {
  domain: DomainKey;
  angle: number;
  tip: Point;
  point: Point;
  pct: number;
  label: { x: number; y: number; anchor: 'start' | 'middle' | 'end'; placement: 'above' | 'below' | 'side' };
}

export interface CompassGeometry {
  width: number;
  height: number;
  cx: number;
  cy: number;
  radius: number;
  axes: CompassAxis[];
  rings: string[];
  shape: string;
  target: string | null;
  previous: string | null;
}

/** Layout box shared by every renderer: wide enough that the E and W labels never clip. */
export const COMPASS_WIDTH = 460;
export const COMPASS_HEIGHT = 380;

const round = (n: number) => Math.round(n * 10) / 10;
const clampPct = (n: number) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));

export function compassGeometry(input: {
  pct: Record<DomainKey, number>;
  targetPct?: number | null;
  previousPct?: Record<DomainKey, number> | null;
}): CompassGeometry {
  const width = COMPASS_WIDTH;
  const height = COMPASS_HEIGHT;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 120;
  const at = (angle: number, r: number): Point => {
    const rad = (angle * Math.PI) / 180;
    return [round(cx + r * Math.cos(rad)), round(cy + r * Math.sin(rad))];
  };
  const angleOf = (i: number) => -90 + i * 90;
  const polygon = (pcts: Record<DomainKey, number>) =>
    DOMAIN_ORDER.map((d, i) => at(angleOf(i), (radius * clampPct(pcts[d])) / 100).join(',')).join(' ');
  const ring = (fraction: number) => DOMAIN_ORDER.map((_, i) => at(angleOf(i), radius * fraction).join(',')).join(' ');

  const axes = DOMAIN_ORDER.map((domain, i): CompassAxis => {
    const angle = angleOf(i);
    const tip = at(angle, radius);
    const pct = clampPct(input.pct[domain]);
    const label: CompassAxis['label'] =
      i === 0
        ? { x: cx, y: tip[1] - 16, anchor: 'middle', placement: 'above' }
        : i === 2
          ? { x: cx, y: tip[1] + 16, anchor: 'middle', placement: 'below' }
          : { x: tip[0] + (i === 1 ? 16 : -16), y: cy, anchor: i === 1 ? 'start' : 'end', placement: 'side' };
    return { domain, angle, tip, point: at(angle, (radius * pct) / 100), pct, label };
  });

  return {
    width,
    height,
    cx,
    cy,
    radius,
    axes,
    rings: [0.25, 0.5, 0.75, 1].map(ring),
    shape: polygon(input.pct),
    target: input.targetPct != null ? ring(clampPct(input.targetPct) / 100) : null,
    previous: input.previousPct ? polygon(input.previousPct) : null,
  };
}

export interface LabelLayout {
  /** "N · PHYSICAL" */
  eyebrow: string;
  anchor: 'start' | 'middle' | 'end';
  /** A swatch dot in the domain colour ties the label to its vertex; the text itself stays in ink. */
  dot: Point;
  eyebrowAt: Point;
  valueAt: Point;
}

export function labelLayout(axis: CompassAxis): LabelLayout {
  const meta = DOMAIN_META[axis.domain];
  const eyebrow = `${meta.dir} · ${meta.short.toUpperCase()}`;
  const { x, y, anchor, placement } = axis.label;
  const eyebrowY = placement === 'above' ? y - 22 : placement === 'below' ? y + 10 : y - 6;
  const valueY = placement === 'above' ? y : placement === 'below' ? y + 32 : y + 16;
  const width = eyebrow.length * 7.1; // 11px bold caps with 1px tracking
  if (anchor === 'start') return { eyebrow, anchor, dot: [x + 4, eyebrowY - 4], eyebrowAt: [x + 14, eyebrowY], valueAt: [x + 14, valueY] };
  if (anchor === 'end') return { eyebrow, anchor, dot: [round(x - width - 10), eyebrowY - 4], eyebrowAt: [x, eyebrowY], valueAt: [x, valueY] };
  return { eyebrow, anchor, dot: [round(x - width / 2 - 3), eyebrowY - 4], eyebrowAt: [x + 7, eyebrowY], valueAt: [x, valueY] };
}

export const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

interface ChartParts {
  pct: Record<DomainKey, number>;
  targetPct: number | null;
  previousPct: Record<DomainKey, number> | null;
}

/** The chart body (no <svg> wrapper), positioned in the COMPASS_WIDTH × COMPASS_HEIGHT box. */
function chartBody({ pct, targetPct, previousPct }: ChartParts): string {
  const g = compassGeometry({ pct, targetPct, previousPct });
  const font = `font-family="${FONT_FAMILY}"`;
  const out: string[] = [];
  for (const ring of g.rings) out.push(`<polygon points="${ring}" fill="none" stroke="${COLORS.line}" stroke-width="1"/>`);
  for (const axis of g.axes) {
    out.push(`<line x1="${g.cx}" y1="${g.cy}" x2="${axis.tip[0]}" y2="${axis.tip[1]}" stroke="${COLORS.line}" stroke-width="1"/>`);
  }
  if (g.target) {
    out.push(`<polygon points="${g.target}" fill="none" stroke="${COLORS.muted}" stroke-width="1.5" stroke-dasharray="5 4" stroke-linejoin="round"/>`);
  }
  if (g.previous) {
    out.push(`<polygon points="${g.previous}" fill="none" stroke="${COLORS.faint}" stroke-width="2" stroke-linejoin="round"/>`);
  }
  out.push(`<polygon points="${g.shape}" fill="${COLORS.brand}" fill-opacity="0.12" stroke="${COLORS.brand}" stroke-width="2" stroke-linejoin="round"/>`);
  out.push(`<circle cx="${g.cx}" cy="${g.cy}" r="2" fill="${COLORS.faint}"/>`);
  for (const axis of g.axes) {
    const color = DOMAIN_COLORS[axis.domain];
    const layout = labelLayout(axis);
    out.push(`<circle cx="${axis.point[0]}" cy="${axis.point[1]}" r="6" fill="${color}" stroke="${COLORS.surface}" stroke-width="2"/>`);
    out.push(`<circle cx="${layout.dot[0]}" cy="${layout.dot[1]}" r="4" fill="${color}"/>`);
    out.push(
      `<text x="${layout.eyebrowAt[0]}" y="${layout.eyebrowAt[1]}" text-anchor="${layout.anchor}" ${font} font-size="11" font-weight="700" letter-spacing="1" fill="${COLORS.muted}">${escapeXml(layout.eyebrow)}</text>`,
    );
    out.push(
      `<text x="${layout.valueAt[0]}" y="${layout.valueAt[1]}" text-anchor="${layout.anchor}" ${font} font-size="20" font-weight="800" fill="${COLORS.ink}">${Math.round(pct[axis.domain])}%</text>`,
    );
  }
  return out.join('');
}

/** The chart alone, on white; embedded in the PDF next to the domain table and legend. */
export function renderCompassSvg(parts: ChartParts): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${COMPASS_WIDTH}" height="${COMPASS_HEIGHT}" viewBox="0 0 ${COMPASS_WIDTH} ${COMPASS_HEIGHT}"><rect width="100%" height="100%" fill="${COLORS.surface}"/>${chartBody(parts)}</svg>`;
}

export interface SnapshotCardInput extends ChartParts {
  childName: string;
  band: BandKey;
  ageText: string;
  dateText: string;
  reference: string;
  overallPct: number;
  stats: Record<DomainKey, { done: number; total: number; pct: number }>;
  previousLabel: string | null;
  /** data: URI of the Shichida India sun mark. */
  logoDataUri: string | null;
}

export const SNAPSHOT_WIDTH = 600;
export const SNAPSHOT_HEIGHT = 860;

/**
 * A self-contained, shareable image of the reading (for WhatsApp or the record thumbnail):
 * brand header, the chart, the headline number, a legend, a per-domain table and the disclaimer.
 */
export function renderSnapshotCardSvg(input: SnapshotCardInput): string {
  const W = SNAPSHOT_WIDTH;
  const font = `font-family="${FONT_FAMILY}"`;
  const pad = 32;
  const out: string[] = [];
  out.push(`<rect width="${W}" height="${SNAPSHOT_HEIGHT}" fill="${COLORS.surface}"/>`);
  out.push(`<rect width="${W}" height="6" fill="${COLORS.sun}"/>`);

  if (input.logoDataUri) {
    out.push(`<image href="${input.logoDataUri}" x="${pad}" y="26" width="44" height="46" preserveAspectRatio="xMidYMid meet"/>`);
  }
  const hx = input.logoDataUri ? pad + 56 : pad;
  out.push(`<text x="${hx}" y="48" ${font} font-size="17" font-weight="800" fill="${COLORS.ink}">Shichida India</text>`);
  out.push(`<text x="${hx}" y="68" ${font} font-size="13" font-weight="600" fill="${COLORS.muted}">Early Compass</text>`);
  out.push(`<text x="${W - pad}" y="48" text-anchor="end" ${font} font-size="13" font-weight="600" fill="${COLORS.muted}">${escapeXml(input.dateText)}</text>`);
  out.push(`<text x="${W - pad}" y="68" text-anchor="end" ${font} font-size="12" font-weight="600" fill="${COLORS.muted}">${escapeXml(input.reference)}</text>`);
  out.push(`<line x1="${pad}" y1="92" x2="${W - pad}" y2="92" stroke="${COLORS.line}" stroke-width="1"/>`);

  out.push(`<text x="${pad}" y="132" ${font} font-size="26" font-weight="800" letter-spacing="-0.5" fill="${COLORS.ink}">${escapeXml(input.childName)}’s compass</text>`);
  out.push(`<text x="${pad}" y="156" ${font} font-size="14" font-weight="500" fill="${COLORS.ink2}">${escapeXml(`${BAND_LABEL[input.band]} checklist · age ${input.ageText}`)}</text>`);

  const chartX = (W - COMPASS_WIDTH) / 2;
  out.push(`<g transform="translate(${chartX} 170)">${chartBody(input)}</g>`);

  // Headline number (sans, proportional figures) and legend
  let y = 170 + COMPASS_HEIGHT + 40;
  const overall = String(Math.round(input.overallPct));
  out.push(`<text x="${pad}" y="${y}" ${font} font-size="44" font-weight="800" letter-spacing="-1" fill="${COLORS.ink}">${overall}%</text>`);
  // 44px ExtraBold: each digit is about 27 units wide and "%" about 40; then a 16-unit gap.
  const captionX = pad + overall.length * 27 + 40 + 16;
  out.push(`<text x="${captionX}" y="${y - 20}" ${font} font-size="14" font-weight="700" fill="${COLORS.ink}">of milestones observed</text>`);
  out.push(`<text x="${captionX}" y="${y}" ${font} font-size="13" font-weight="500" fill="${COLORS.muted}">${escapeXml(`${BAND_LABEL[input.band]} checklist`)}</text>`);

  y += 30;
  let lx = pad;
  const legendItem = (key: string, text: string) => {
    out.push(key);
    out.push(`<text x="${lx + 30}" y="${y + 4}" ${font} font-size="12.5" font-weight="600" fill="${COLORS.ink2}">${escapeXml(text)}</text>`);
    lx += 30 + text.length * 6.9 + 22;
  };
  legendItem(`<line x1="${lx}" y1="${y}" x2="${lx + 22}" y2="${y}" stroke="${COLORS.brand}" stroke-width="3" stroke-linecap="round"/>`, 'This assessment');
  if (input.targetPct != null) {
    legendItem(`<line x1="${lx}" y1="${y}" x2="${lx + 22}" y2="${y}" stroke="${COLORS.muted}" stroke-width="2" stroke-dasharray="5 4"/>`, `Target for age (${input.targetPct}%)`);
  }
  if (input.previousPct && input.previousLabel) {
    legendItem(`<line x1="${lx}" y1="${y}" x2="${lx + 22}" y2="${y}" stroke="${COLORS.faint}" stroke-width="3" stroke-linecap="round"/>`, input.previousLabel);
  }

  // Domain table: the chart's table-view twin.
  y += 24;
  for (const domain of DOMAIN_ORDER) {
    const s = input.stats[domain];
    y += 34;
    out.push(`<line x1="${pad}" y1="${y - 22}" x2="${W - pad}" y2="${y - 22}" stroke="${COLORS.line}" stroke-width="1"/>`);
    out.push(`<circle cx="${pad + 6}" cy="${y - 5}" r="6" fill="${DOMAIN_COLORS[domain]}"/>`);
    out.push(`<text x="${pad + 22}" y="${y}" ${font} font-size="15" font-weight="700" fill="${COLORS.ink}">${DOMAIN_META[domain].name}</text>`);
    out.push(`<text x="${W - pad - 70}" y="${y}" text-anchor="end" ${font} font-size="13" font-weight="600" fill="${COLORS.muted}">${s.done} of ${s.total}</text>`);
    out.push(`<text x="${W - pad}" y="${y}" text-anchor="end" ${font} font-size="15" font-weight="800" fill="${COLORS.ink}">${Math.round(s.pct)}%</text>`);
  }

  out.push(`<text x="${W / 2}" y="${SNAPSHOT_HEIGHT - 22}" text-anchor="middle" ${font} font-size="11.5" font-weight="500" fill="${COLORS.muted}">A reference tool, not a diagnostic instrument. Talk with your paediatrician about any concerns.</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${SNAPSHOT_HEIGHT}" viewBox="0 0 ${W} ${SNAPSHOT_HEIGHT}">${out.join('')}</svg>`;
}
