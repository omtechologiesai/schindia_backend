/**
 * The milestone checklist as used at runtime. Administrators can add and remove questions, so the
 * live list is stored in the database, starting from the original Shichida checklist
 * (data/checklist.ts). Item ids are "band:domain:number" and a number is never reused, so a
 * removed question can't be confused with one added later.
 */
import { CHECKLIST } from './data/checklist';
import { BANDS, DOMAIN_ORDER, itemId, type BandKey, type DomainKey } from './domain';

export interface ChecklistItem {
  id: string;
  text: string;
}

/** One age band's questions per domain, in checklist order. */
export type BandItems = Record<DomainKey, ChecklistItem[]>;
export type Checklist = Record<BandKey, BandItems>;

export function emptyBandItems(): BandItems {
  return { physical: [], sensory: [], language: [], social: [] };
}

/** The original 480-item checklist with its ids: the starting set for the database. */
export function seedChecklist(): Checklist {
  return Object.fromEntries(
    BANDS.map((band) => [
      band,
      Object.fromEntries(DOMAIN_ORDER.map((domain) => [domain, CHECKLIST[band][domain].map((text, i) => ({ id: itemId(band, domain, i), text }))])),
    ]),
  ) as Checklist;
}

/** The questions a saved assessment was answered against, rebuilt from its stored responses. */
export function itemsFromResponses(responses: readonly { id: string; domain: DomainKey; text: string }[]): BandItems {
  const items = emptyBandItems();
  for (const response of responses) items[response.domain].push({ id: response.id, text: response.text });
  return items;
}
