/**
 * Shichida India visual identity, shared by the portal (via tailwind.config.ts), the PDF,
 * the email and the chart snapshot.
 *
 * Surfaces and ink follow the Shichida Digital parent portal: warm cream ground, white cards,
 * olive brand reserved for small solid features. The logo's sun orange is decorative only; it
 * fails text contrast, so it never carries text.
 *
 * DOMAIN_COLORS is a validated categorical palette, tuned from the Shichida Digital compass
 * tokens (which read as grey and collided for colour-blind readers). All four pass the data-viz
 * checks for every pair, not just neighbours, because the compass shows all four at once:
 * OKLCH lightness band, chroma ≥ 0.10, protan/deutan ΔE ≥ 8 (worst 11.1), normal-vision ΔE ≥ 15
 * (worst 15.4) and ≥ 3:1 contrast on both white and cream. Re-run the validator before changing one.
 */
import type { DomainKey } from './domain';

export const COLORS = {
  paper: '#F7F5EF',
  paper2: '#F1EFE7',
  surface: '#FFFFFF',
  surface2: '#FAF9F4',
  line: '#E8E5DB',
  lineStrong: '#D8D4C6',
  ink: '#2F3329',
  ink2: '#55584D',
  /** Secondary text; 5.7:1 on white, 5.2:1 on cream. */
  muted: '#66685D',
  /** Decorative only (2.3:1): disabled states, the previous-assessment outline. */
  faint: '#A9AA9F',
  brand: '#5A6449',
  brandHot: '#4A5339',
  brandSoft: '#EAEDE2',
  brandLine: '#CFD6C1',
  brandInk: '#3E4632',
  sun: '#F8A018',
  sunSoft: '#FDF1DC',
  sand: '#B08A3E',
  sandSoft: '#F6EEDC',
  danger: '#A8412C',
  dangerSoft: '#F7E5E2',
} as const;

export const DOMAIN_COLORS: Record<DomainKey, string> = {
  physical: '#B9832C',
  sensory: '#019D90',
  language: '#AD4A46',
  social: '#4A71B1',
};

/** Background tints for icon wells and bar tracks; never used for marks or text. */
export const DOMAIN_SOFT: Record<DomainKey, string> = {
  physical: '#F9EEE0',
  sensory: '#E1F5F2',
  language: '#FFEBE9',
  social: '#EAF1FB',
};

export const FONT_FAMILY = 'Plus Jakarta Sans';

export const FONT_STACK =
  '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
