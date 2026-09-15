/**
 * Core vocabulary of the Early Compass: the four Shichida developmental domains
 * (read as compass directions) and the three age bands the checklist is split into.
 */

export type DomainKey = 'physical' | 'sensory' | 'language' | 'social';
export type BandKey = '0-2' | '2-4' | '4-6';
export type CompassDirection = 'N' | 'E' | 'S' | 'W';

/** Clockwise from North. This order is also the colour-slot order in brand.ts. */
export const DOMAIN_ORDER: readonly DomainKey[] = ['physical', 'sensory', 'language', 'social'];

export const BANDS: readonly BandKey[] = ['0-2', '2-4', '4-6'];

export const BAND_LABEL: Record<BandKey, string> = {
  '0-2': '0–2 years',
  '2-4': '2–4 years',
  '4-6': '4–6 years',
};

/** Age range in months that each band covers; drives the age-based attainment target. */
export const BAND_BOUNDS: Record<BandKey, readonly [number, number]> = {
  '0-2': [0, 24],
  '2-4': [24, 48],
  '4-6': [48, 72],
};

export interface DomainMeta {
  key: DomainKey;
  name: string;
  short: string;
  dir: CompassDirection;
  blurb: string;
}

export const DOMAIN_META: Record<DomainKey, DomainMeta> = {
  physical: { key: 'physical', name: 'Physical Development', short: 'Physical', dir: 'N', blurb: 'Gross & fine motor' },
  sensory: { key: 'sensory', name: 'Sensory Development', short: 'Sensory', dir: 'E', blurb: 'Senses & manipulation' },
  language: { key: 'language', name: 'Language Development', short: 'Language', dir: 'S', blurb: 'Speech & comprehension' },
  social: { key: 'social', name: 'Social Development', short: 'Social', dir: 'W', blurb: 'Self-care & relationships' },
};

export function isBandKey(value: unknown): value is BandKey {
  return typeof value === 'string' && (BANDS as readonly string[]).includes(value);
}

/** Stable id for a checklist item: band, domain and item number (never reused), e.g. "2-4:language:7". */
export function itemId(band: BandKey, domain: DomainKey, index: number): string {
  return `${band}:${domain}:${index + 1}`;
}
