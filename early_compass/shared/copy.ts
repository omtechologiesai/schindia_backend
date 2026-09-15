/**
 * Brand names and every disclaimer, in one place. The portal, the PDF, the email, the
 * WhatsApp message and the public report page all read from here so the wording a parent
 * sees is identical wherever it appears.
 *
 * The disclaimers are retained from the Shape Early Compass, rebranded and in Indian English.
 * One line was deliberately not carried over: "Data is stored only on this device and never
 * leaves your browser session". Records are now saved and shared, so DATA_NOTICE replaces it.
 */

export const ORG_NAME = 'Shichida India';
export const PRODUCT_NAME = 'Early Compass';
export const PRODUCT_FULL_NAME = `${ORG_NAME} ${PRODUCT_NAME}`;
export const PRODUCT_TAGLINE = 'A cross-referenced guide to early childhood development, ages 0–6';
export const PRODUCT_DESCRIPTION =
  'Based on the Shichida Method developmental assessment, cross-referenced with CDC/AAP and WHO benchmarks.';

/** "Shichida India (Indiranagar)", without repeating the brand when the centre name already includes it. */
export function orgAndCentre(centre: string): string {
  const name = centre.trim();
  if (!name) return ORG_NAME;
  return name.toLowerCase().includes(ORG_NAME.toLowerCase()) ? name : `${ORG_NAME} (${name})`;
}

export const DISCLAIMER_FOOTER =`${PRODUCT_FULL_NAME} · a reference tool, not a diagnostic instrument · talk with your paediatrician about any developmental concerns`;

export const DISCLAIMER_NOT_DIAGNOSTIC = {
  title: 'Not a diagnostic tool',
  body: "These checklists describe typical ranges, not a clinical assessment. If your child isn't meeting milestones, has lost a skill they once had, or you have any other concern, talk with your child's doctor and ask about a standardised developmental screening — acting early makes a real difference.",
} as const;

export const COMPASS_READING_NOTE =
  "The compass is oriented N–Physical, E–Sensory, S–Language, W–Social. It reflects only the milestones observed in this assessment — every child's shape is different, and a smaller reading in one direction just points to where to focus play next, not a deficit.";

export const CHECKLIST_GUIDANCE = 'Tick each milestone the child can do. There is no pass mark.';

export function targetExplainer(ageText: string, bandText: string, targetPct: number): string {
  return `Based on ${ageText} and a typical pace through the ${bandText} band, ${targetPct}% observed is a reasonable expectation.`;
}

export function customTargetExplainer(targetPct: number, autoTargetPct: number): string {
  return `A custom target of ${targetPct}% was set for this assessment (the age-based expectation is ${autoTargetPct}%).`;
}

export function onTargetMessage(targetPct: number): string {
  return `Every domain is at or above the ${targetPct}% target for this band — nice pace.`;
}

export const CDC_NOTE =
  'Paraphrased from the CDC and American Academy of Pediatrics "Learn the Signs. Act Early." milestone checklists (updated Feb. 2022). These list what ~75% of children typically do by each checkup age.';

export const WHO_NOTE =
  'A six-milestone gross-motor sequence from the WHO Multicentre Growth Reference Study (2006), shown as the age range (1st–99th percentile, in months) within which most healthy children reach each milestone.';

export const ASQ_NOTE =
  "ASQ-3, a widely used parent-completed screening tool, organises items into five domains: Communication, Gross Motor, Fine Motor, Problem Solving, and Personal-Social. Its specific questions are copyrighted and aren't reproduced here, but its domain structure maps closely onto Shichida's four: Physical splits across ASQ's Gross and Fine Motor, Sensory overlaps Fine Motor and Problem Solving, Language maps to Communication, and Social maps to Personal-Social.";

export const SOURCES: readonly { title: string; body: string; ref?: string }[] = [
  {
    title: 'Shichida Method — Developmental Assessment',
    body: '480 checklist items across Physical, Sensory, Language and Social development (ages 0–6, in three bands), from the Shichida "2016 Developmental Assessment", © 2016 Shichida Educational Institute. The companion "Goals by Age" framework supplies the attainment goals.',
  },
  {
    title: 'CDC / AAP "Learn the Signs. Act Early."',
    body: 'U.S. milestone checklists (public domain), revised with the American Academy of Pediatrics in February 2022, covering checkups from 2 months to 5 years across four domains. Items shown here are paraphrased summaries, not verbatim reproductions.',
    ref: 'cdc.gov/act-early',
  },
  {
    title: 'WHO Multicentre Growth Reference Study',
    body: '"Windows of achievement for six gross motor development milestones," WHO Motor Development Study, Acta Paediatrica Supplement 450 (2006): 86–95 — longitudinal data from 816 children across five countries.',
  },
  {
    title: 'Ages & Stages Questionnaire, 3rd ed. (ASQ-3)',
    body: 'Referenced only for its five-domain structure (Communication, Gross Motor, Fine Motor, Problem Solving, Personal-Social); its copyrighted item content is not reproduced.',
  },
];

export const DATA_NOTICE =
  'Assessment details are kept in Shichida India records and shared only with the parent or guardian contact on file.';
