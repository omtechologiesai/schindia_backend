/**
 * End-to-end through the HTTP API on throwaway DynamoDB Local tables and a temporary files
 * directory: sign-in, recording an assessment, the generated files, email preview, WhatsApp
 * click-to-chat, the parent link and a follow-up assessment with growth commentary.
 */
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AssessmentDTO, ChecklistDTO } from '@shared/api';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-compass-test-'));
// Empty strings rather than deletes, so a developer's .env can't fill them back in (and send
// email through SES or write to S3 from a test run).
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  APP_SECRET: 'test-secret-for-signing-links-0123456789abcdef',
  PUBLIC_BASE_URL: 'https://compass.example.org',
  BASE_PATH: '/compass',
  DYNAMODB_ENDPOINT: inject('dynamodbEndpoint'),
  DYNAMODB_TABLE_PREFIX: `EarlyCompassTest-${Date.now()}`,
  AWS_REGION: 'ap-south-1',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  EMAIL_MODE: 'preview',
  S3_BUCKET: '',
  SMTP_HOST: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  WHATSAPP_ACCESS_TOKEN: '',
  INTERNAL_WEBHOOK_URL: '',
  CENTRES: '',
  TRUST_PROXY: 'false',
});

let server: Server;
let base = '';
let cookie = '';
let setCookieHeader = '';

/** Paths are relative to /compass, where the app is mounted. */
async function api(pathname: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'X-Requested-With': 'EarlyCompass', ...init.headers };
  if (cookie) headers.cookie = cookie;
  if (init.json !== undefined) headers['Content-Type'] = 'application/json';
  const url = pathname.startsWith('/compass/') ? base + pathname : `${base}/compass${pathname}`;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    setCookieHeader = setCookie;
    cookie = setCookie.split(';')[0]!;
  }
  return res;
}

function dobMonthsAgo(months: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

const firstN = (band: string, domain: string, n: number) => Array.from({ length: n }, (_, i) => `${band}:${domain}:${i + 1}`);

const submission = {
  childId: null as string | null,
  child: { firstName: 'Aarav', lastName: 'Sharma', dateOfBirth: dobMonthsAgo(34), gender: 'Male', centre: 'Indiranagar' },
  parent: { name: 'Meera Sharma', relation: 'Mother', phone: '98765 43210', email: 'Meera@Example.org' },
  band: '2-4',
  observed: [...firstN('2-4', 'physical', 20), ...firstN('2-4', 'sensory', 18), ...firstN('2-4', 'language', 16), ...firstN('2-4', 'social', 10)],
  goals: { age: '2', achieved: ['2|Imagination|1', '2|Number|2'] },
  interests: ['books', 'music'],
  targetOverride: null,
  notes: 'Settled quickly and enjoyed the puzzles.',
};

let first: AssessmentDTO;

beforeAll(async () => {
  const { setupTables } = await import('../server/db');
  const { users } = await import('../server/repo');
  const { hashPassword } = await import('../server/security');
  const { createApp } = await import('../server/app');
  await setupTables();
  await users.create({
    email: 'priya@example.org',
    name: 'Priya Nair',
    role: 'admin',
    centre: 'Indiranagar',
    passwordHash: await hashPassword('correct horse battery'),
  });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('access control', () => {
  it('requires a session and the app header', async () => {
    expect((await fetch(`${base}/compass/api/assessments`)).status).toBe(401);
    const noHeader = await fetch(`${base}/compass/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'priya@example.org', password: 'correct horse battery' }),
    });
    expect(noHeader.status).toBe(403);
  });

  it('only serves under the base path', async () => {
    expect((await fetch(`${base}/compass/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/api/assessments`)).status).toBe(404);
  });

  it('rejects a wrong password and signs in with the right one', async () => {
    expect((await api('/api/auth/login', { method: 'POST', json: { email: 'priya@example.org', password: 'nope' } })).status).toBe(401);
    const res = await api('/api/auth/login', { method: 'POST', json: { email: 'PRIYA@example.org', password: 'correct horse battery' } });
    expect(res.status).toBe(200);
    expect(cookie).toMatch(/^ec_session=/);
    // Scoped to the app, so the cookie never reaches the Shichida admin app on the same site.
    expect(setCookieHeader).toContain('Path=/compass');
    expect((await api('/api/auth/me')).status).toBe(200);
  });

  it('refuses a second account with the same email', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      json: { name: 'Priya Again', email: 'Priya@Example.org', role: 'staff', centre: '', password: 'another long password' },
    });
    expect(res.status).toBe(409);
  });
});

describe('recording an assessment', () => {
  it('validates on the server', async () => {
    const res = await api('/api/assessments', {
      method: 'POST',
      json: { ...submission, parent: { ...submission.parent, phone: '12345' } },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors['parent.phone']).toBeTruthy();

    const wrongBand = await api('/api/assessments', { method: 'POST', json: { ...submission, observed: ['0-2:physical:1'] } });
    expect(wrongBand.status).toBe(422);
  });

  it('saves the record, recomputes the results and renders the report files', async () => {
    const res = await api('/api/assessments', { method: 'POST', json: submission });
    expect(res.status).toBe(201);
    first = (await res.json()) as AssessmentDTO;
    expect(first.reference).toMatch(/^EC-\d{4}-00001$/);
    expect(first.band).toBe('2-4');
    expect(first.bandOverridden).toBe(false);
    expect(first.child.parent).toMatchObject({ phone: '+919876543210', email: 'meera@example.org' });
    expect(first.stats.physical).toEqual({ done: 20, total: 36, pct: (20 / 36) * 100 });
    expect(first.overallPct).toBeCloseTo((64 / 144) * 100);
    expect(first.responses).toHaveLength(144);
    expect(first.goals?.items.filter((g) => g.achieved).map((g) => g.id)).toEqual(['2|Imagination|1', '2|Number|2']);
    expect(first.previous).toBeNull();
    expect(first.report.version).toBe(1);
    expect(first.report.error).toBeNull();
    expect(first.report.pdfUrl).toMatch(/^\/compass\/api\/assessments\//);

    const pdf = await api(first.report.pdfUrl);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    for (const url of [first.report.snapshotUrl, first.report.chartUrl]) {
      const png = Buffer.from(await (await api(url)).arrayBuffer());
      expect(png.subarray(1, 4).toString()).toBe('PNG');
    }
  }, 60_000);

  it('lists the assessment and the child', async () => {
    const listed = (await (await api('/api/assessments')).json()) as { total: number; items: { id: string; child: { firstName: string } }[] };
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({ id: first.id, child: { firstName: 'Aarav' } });
    const kids = (await (await api('/api/children')).json()) as { total: number; items: { assessmentCount: number }[] };
    expect(kids.total).toBe(1);
    expect(kids.items[0]!.assessmentCount).toBe(1);
  });

  it('saves an email preview when email sending is not configured', async () => {
    const res = await api(`/api/assessments/${first.id}/share/email`, {
      method: 'POST',
      json: { to: 'meera@example.org', message: 'Lovely session today!' },
    });
    expect(res.status).toBe(200);
    const { delivery } = (await res.json()) as AssessmentDTO & { delivery: AssessmentDTO['deliveries'][number] };
    expect(delivery).toMatchObject({ channel: 'email', mode: 'preview', status: 'prepared', recipient: 'meera@example.org', sentBy: 'Priya Nair' });
    expect(delivery.reportVariant).toBe('full');
    const eml = await (await api(delivery.previewUrl!)).text();
    expect(eml).toContain('To: meera@example.org');
    expect(eml).toContain('Content-Type: application/pdf');
    expect(eml).toContain('Early-Compass_Aarav-Sharma_');
  });

  it('prepares a WhatsApp click-to-chat message with the signed report link', async () => {
    const res = await api(`/api/assessments/${first.id}/share/whatsapp`, { method: 'POST', json: { to: '+91 98765 43210' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; message: string };
    expect(body.url).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
    expect(body.message).toContain('https://compass.example.org/compass/r/');
    expect(body.message).toContain('Not a diagnostic tool');
  });

  it('serves the parent page from the signed link, and stops once links are revoked', async () => {
    const record = (await (await api(`/api/assessments/${first.id}`)).json()) as AssessmentDTO;
    expect(record.deliveries).toHaveLength(2);
    const pathname = new URL(record.share.url).pathname;
    expect(pathname).toMatch(/^\/compass\/r\//);

    const page = await fetch(base + pathname);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Aarav’s Early Compass report');
    expect(html).toContain('Not a diagnostic tool');
    expect(html).toContain(`src="${pathname}/snapshot.png"`);
    expect((await fetch(`${base}${pathname}/report.pdf`)).headers.get('content-type')).toBe('application/pdf');

    const tampered = pathname.slice(0, -1) + (pathname.endsWith('A') ? 'B' : 'A');
    expect((await fetch(base + tampered)).status).toBe(404);

    expect((await api(`/api/assessments/${first.id}/share-link/revoke`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(base + pathname)).status).toBe(404);
  });

  it('sends the short report when asked, and the parent link follows what was sent', async () => {
    const pages = async (res: Response) => (await PDFDocument.load(await res.arrayBuffer())).getPageCount();
    const full = await api(first.report.pdfUrl);
    expect(await pages(full)).toBeGreaterThan(3);
    expect(await pages(await api(first.report.shortPdfUrl))).toBe(3);

    // Sharing the short report
    const shared = await api(`/api/assessments/${first.id}/share/email`, {
      method: 'POST',
      json: { to: 'meera@example.org', message: '', variant: 'short' },
    });
    expect(shared.status).toBe(200);
    const { delivery } = (await shared.json()) as { delivery: AssessmentDTO['deliveries'][number] };
    expect(delivery.reportVariant).toBe('short');
    const eml = await (await api(delivery.previewUrl!)).text();
    expect(eml).toContain('Early-Compass_Aarav-Sharma_');
    expect(eml).toContain('_short.pdf');

    const record = (await (await api(`/api/assessments/${first.id}`)).json()) as AssessmentDTO;
    expect(record.share.variant).toBe('short');
    const shortLink = await fetch(`${new URL(record.share.url).pathname.replace('/compass', base + '/compass')}/report.pdf`);
    expect(await pages(shortLink)).toBe(3);

    // Sharing the complete report again puts the link back
    await api(`/api/assessments/${first.id}/share/whatsapp`, { method: 'POST', json: { to: '+91 98765 43210', variant: 'full' } });
    const after = (await (await api(`/api/assessments/${first.id}`)).json()) as AssessmentDTO;
    expect(after.share.variant).toBe('full');
    expect(after.deliveries[0]!.reportVariant).toBe('full');
    const fullLink = await fetch(`${new URL(after.share.url).pathname.replace('/compass', base + '/compass')}/report.pdf`);
    expect(await pages(fullLink)).toBeGreaterThan(3);
  }, 60_000);

  it('corrects the details from an assessment and renders a new report version', async () => {
    const edit = (child: object, parent: object = {}) =>
      api(`/api/assessments/${first.id}/details`, {
        method: 'PUT',
        json: { child: { ...submission.child, ...child }, parent: { ...submission.parent, ...parent } },
      });

    const afterAssessment = await edit({ dateOfBirth: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) });
    expect(afterAssessment.status).toBe(422);
    expect(((await afterAssessment.json()) as { fieldErrors: Record<string, string> }).fieldErrors['child.dateOfBirth']).toBeTruthy();

    const unchanged = (await (await edit({})).json()) as AssessmentDTO;
    expect(unchanged.report.version).toBe(first.report.version);

    const res = await edit({ firstName: 'Aarush', dateOfBirth: dobMonthsAgo(26) }, { email: 'meera.s@example.org' });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as AssessmentDTO;
    expect(updated.report.version).toBe(first.report.version + 1);
    expect(updated.child).toMatchObject({ firstName: 'Aarush', parent: { email: 'meera.s@example.org' } });
    expect(updated.ageMonths).toBeLessThan(first.ageMonths);
    expect(updated.targetPct).toBeLessThan(first.targetPct);
    expect(updated.stats).toEqual(first.stats);

    const listed = (await (await api('/api/assessments?q=aarush')).json()) as { total: number };
    expect(listed.total).toBe(1);
  }, 60_000);

  it('links a follow-up to the same child with growth commentary', async () => {
    const res = await api('/api/assessments', {
      method: 'POST',
      json: { ...submission, childId: first.child.id, observed: [...submission.observed, ...firstN('2-4', 'social', 20)] },
    });
    expect(res.status).toBe(201);
    const second = (await res.json()) as AssessmentDTO;
    expect(second.reference).toMatch(/-00002$/);
    expect(second.child.id).toBe(first.child.id);
    expect(second.previous?.id).toBe(first.id);
    expect(second.commentary.narrative).toMatch(/^Since the assessment on /);
    expect(second.commentary.deltas?.find((d) => d.domain === 'social')?.delta).toBeGreaterThan(0);

    const profile = (await (await api(`/api/children/${first.child.id}`)).json()) as { assessments: unknown[] };
    expect(profile.assessments).toHaveLength(2);
    const byPhone = (await (await api('/api/assessments?q=98765')).json()) as { total: number };
    expect(byPhone.total).toBe(2);
    const byReference = (await (await api(`/api/assessments?q=${second.reference.toLowerCase()}`)).json()) as { total: number };
    expect(byReference.total).toBe(1);
    const byName = (await (await api('/api/children?q=aarav')).json()) as { total: number };
    expect(byName.total).toBe(1);
  }, 60_000);

  it('lets an administrator erase a child with all records and files', async () => {
    expect((await api(`/api/children/${first.child.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/api/assessments/${first.id}`)).status).toBe(404);
    expect(fs.existsSync(path.join(dataDir, 'reports', first.id))).toBe(false);
    expect(fs.readdirSync(path.join(dataDir, 'outbox'))).toHaveLength(0);
    expect(((await (await api('/api/assessments')).json()) as { total: number }).total).toBe(0);
  });
});

describe('the milestone checklist', () => {
  it('is served in full and cannot be changed', async () => {
    const checklist = (await (await api('/api/checklist')).json()) as ChecklistDTO;
    expect(checklist.items['2-4'].physical).toHaveLength(36);
    expect(checklist.items['2-4'].physical[0]!.id).toBe('2-4:physical:1');
    const total = Object.values(checklist.items).flatMap((band) => Object.values(band)).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(480);

    // Adding and removing questions was deliberately dropped: the endpoints no longer exist.
    const added = await api('/api/checklist', { method: 'POST', json: { band: '2-4', domain: 'physical', text: 'Can hop on one foot' } });
    expect(added.status).toBe(404);
    const removed = await api('/api/checklist/2-4:physical:1', { method: 'DELETE' });
    expect(removed.status).toBe(404);
    expect(((await (await api('/api/checklist')).json()) as ChecklistDTO).items['2-4'].physical).toHaveLength(36);
  });
});
