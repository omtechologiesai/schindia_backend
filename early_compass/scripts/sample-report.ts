/**
 * Builds a realistic follow-up assessment in throwaway tables and writes out everything a parent
 * would receive (PDF report, chart, snapshot, email and WhatsApp message) so the report design can
 * be reviewed without clicking through the portal. Needs DynamoDB Local (see tests/dynamodb-local.ts):
 *
 *   java -jar .dynamodb/DynamoDBLocal.jar -inMemory -port 8765 &
 *   DYNAMODB_ENDPOINT=http://127.0.0.1:8765 npm run sample:report -- --out sample-report
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { AssessmentSubmission } from '@shared/schemas';

const { values } = parseArgs({ options: { out: { type: 'string', default: 'sample-report' } } });
const outDir = path.resolve(values.out ?? 'sample-report');
const endpoint = process.env.DYNAMODB_ENDPOINT ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(endpoint)) {
  console.error('Set DYNAMODB_ENDPOINT to a local DynamoDB (e.g. http://127.0.0.1:8765); this script never writes to AWS.');
  process.exit(1);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-compass-sample-'));
// Empty strings rather than deletes, so values from .env can't fill them back in.
Object.assign(process.env, {
  DATA_DIR: dataDir,
  APP_SECRET: 'sample-secret-for-local-previews-only-0000000000',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? 'https://www.brainastra.com',
  DYNAMODB_TABLE_PREFIX: `EarlyCompassSample-${Date.now()}`,
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  EMAIL_MODE: 'preview',
  S3_BUCKET: '',
  SMTP_HOST: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  WHATSAPP_ACCESS_TOKEN: '',
  INTERNAL_WEBHOOK_URL: '',
});

const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
const { ddb } = await import('../server/aws');
const { setupTables, TABLES } = await import('../server/db');
const { assessments, parseAssessment, users } = await import('../server/repo');
const { hashPassword } = await import('../server/security');
const { createAssessment } = await import('../server/services/assessments');
const { readReportFile, reportFileName, shareUrl } = await import('../server/services/reports');
const { renderReportEmail } = await import('../server/services/email');
const { buildWhatsAppMessage } = await import('../server/services/whatsapp');

const monthsAgo = (months: number) => {
  const d = new Date();
  d.setUTCDate(10);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};
const firstItems = (counts: Record<'physical' | 'sensory' | 'language' | 'social', number>) =>
  Object.entries(counts).flatMap(([domain, n]) => Array.from({ length: n }, (_, i) => `2-4:${domain}:${i + 1}`));

await setupTables();
const staff = await users.create({
  email: 'priya.nair@example.org',
  name: 'Priya Nair',
  role: 'admin',
  centre: 'Indiranagar',
  passwordHash: await hashPassword('sample-password-only'),
});

const base: Omit<AssessmentSubmission, 'observed'> = {
  childId: null,
  child: { firstName: 'Aarav', lastName: 'Sharma', dateOfBirth: monthsAgo(34), gender: 'Male', centre: 'Indiranagar' },
  parent: { name: 'Meera Sharma', relation: 'Mother', phone: '98765 43210', email: 'meera.sharma@example.com' },
  band: '2-4',
  goals: null,
  interests: ['books', 'music'],
  targetOverride: null,
  notes: '',
};

const first = await createAssessment({ ...base, observed: firstItems({ physical: 18, sensory: 15, language: 11, social: 20 }) }, staff);
// Backdate the first visit by 13 weeks so the follow-up shows growth commentary.
await ddb.send(
  new UpdateCommand({
    TableName: TABLES.assessments,
    Key: { id: first.id },
    UpdateExpression: 'SET assessed_at = :at, age_months = age_months - :three',
    ExpressionAttributeValues: { ':at': new Date(Date.now() - 91 * 86_400_000).toISOString(), ':three': 3 },
  }),
);

const followUp = await createAssessment(
  {
    ...base,
    childId: first.child_id,
    observed: firstItems({ physical: 26, sensory: 19, language: 13, social: 24 }),
    goals: { age: '2', achieved: ['2|Imagination|1', '2|Imagination|2', '2|Memorization|1', '2|Senses|1', '2|Number|1', '2|Number|3'] },
    notes:
      'Aarav settled quickly and was keen to help tidy up. He loved the shape puzzles, named every colour we tried and counted confidently to 20. Practising two- and three-step instructions at home will help his language.',
  },
  staff,
);

const row = (await assessments.byId(followUp.id))!;
const detail = parseAssessment(row);
fs.mkdirSync(outDir, { recursive: true });
const pdf = (await readReportFile(row, 'pdf'))!;
const snapshot = (await readReportFile(row, 'snapshot'))!;
fs.writeFileSync(path.join(outDir, reportFileName(row, detail)), pdf);
const chart = (await readReportFile(row, 'chart'))!;
fs.writeFileSync(path.join(outDir, 'chart.png'), chart);
fs.writeFileSync(path.join(outDir, 'snapshot.png'), snapshot);

const email = renderReportEmail({
  to: detail.child.parent.email,
  parentName: detail.child.parent.name,
  childFirstName: detail.child.firstName,
  childFullName: `${detail.child.firstName} ${detail.child.lastName}`,
  centre: detail.child.centre,
  assessedAt: row.assessed_at,
  band: row.band,
  overallPct: row.overall_pct,
  stats: detail.stats,
  focusDomains: detail.focusAreas.map((area) => area.domain),
  shareUrl: shareUrl(row),
  shareExpiresAt: row.share_expires_at,
  personalMessage: 'It was lovely meeting Aarav today. The report has a few play ideas to try at home.',
  senderName: staff.name,
  pdf,
  pdfFileName: reportFileName(row, detail),
  chartImage: chart,
});
const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
const logo = fs.readFileSync(path.resolve('server/assets/brand/shichida-india-logo.png'));
fs.writeFileSync(
  path.join(outDir, 'email.html'),
  email.html.replace('cid:logo@early-compass', dataUri(logo)).replace('cid:compass@early-compass', dataUri(chart)),
);
fs.writeFileSync(
  path.join(outDir, 'whatsapp-message.txt'),
  buildWhatsAppMessage({
    parentName: detail.child.parent.name,
    childFirstName: detail.child.firstName,
    centre: detail.child.centre,
    assessedAt: row.assessed_at,
    shareUrl: shareUrl(row),
    shareExpiresAt: row.share_expires_at,
    senderName: staff.name,
  }),
);

console.log(`${row.reference}: ${Math.round(row.overall_pct)}% observed (target ${row.target_pct}%)`);
console.log(`focus areas: ${detail.focusAreas.map((a) => `${a.domain} ${Math.round(a.gap)} pts`).join(', ') || 'none'}`);
console.log(`growth: ${detail.commentary.narrative}`);
console.log(`email subject: ${email.subject}`);
console.log(`written to ${outDir}:\n  ${fs.readdirSync(outDir).join('\n  ')}`);

fs.rmSync(dataDir, { recursive: true, force: true });
