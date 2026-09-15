/**
 * Runtime configuration from environment variables (and an optional .env file).
 * Validated once at start-up so a misconfigured deployment fails loudly instead of at
 * the moment a parent's report is sent.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const ROOT_DIR = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

/** Minimal .env reader. Real environment variables always win over the file. */
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT_DIR, '.env'));

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? fallback : ['true', '1', 'yes', 'on'].includes(v.toLowerCase())));

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

/** false, true, or the number of proxies in front of the app (CloudFront then nginx is 2). */
const proxyHops = z
  .string()
  .optional()
  .transform((v, ctx) => {
    const value = (v ?? '').trim().toLowerCase();
    if (['', 'false', '0', 'no', 'off'].includes(value)) return false;
    if (['true', 'yes', 'on'].includes(value)) return true;
    const hops = Number(value);
    if (Number.isInteger(hops) && hops > 0) return hops;
    ctx.addIssue({ code: 'custom', message: 'Use false, true or a number of proxy hops' });
    return z.NEVER;
  });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  // The path the app lives under on the shared site, e.g. https://www.brainastra.com/compass
  BASE_PATH: z.string().default('/compass'),
  // Which DynamoDB tables to use: EarlyCompass-dev-* (local and staging) or EarlyCompass-production-*
  APP_ENV: z.enum(['dev', 'production']).default('dev'),
  AWS_REGION: z.string().default('ap-south-1'),
  DYNAMODB_TABLE_PREFIX: optional,
  DYNAMODB_ENDPOINT: optional,
  S3_BUCKET: optional,
  S3_PREFIX: z.string().default(''),
  APP_SECRET: optional,
  PUBLIC_BASE_URL: optional,
  DATA_DIR: z.string().default('storage'),
  TIME_ZONE: z.string().default('Asia/Kolkata'),
  SESSION_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  REPORT_LINK_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  TRUST_PROXY: proxyHops,
  CENTRES: z.string().default(''),
  ORG_SUPPORT_EMAIL: z.string().default(''),
  ORG_SUPPORT_PHONE: z.string().default(''),
  ORG_WEBSITE: z.string().default(''),
  ADMIN_EMAIL: optional,
  ADMIN_PASSWORD: optional,
  ADMIN_NAME: optional,
  EMAIL_MODE: z.enum(['preview', 'ses', 'smtp']).default('preview'),
  SES_CONFIGURATION_SET: optional,
  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: flag(false),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  MAIL_FROM: optional,
  MAIL_REPLY_TO: optional,
  WHATSAPP_PHONE_NUMBER_ID: optional,
  WHATSAPP_ACCESS_TOKEN: optional,
  WHATSAPP_API_VERSION: z.string().default('v23.0'),
  WHATSAPP_TEMPLATE_NAME: optional,
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en'),
  INTERNAL_WEBHOOK_URL: optional,
  INTERNAL_WEBHOOK_SECRET: optional,
});

function fail(message: string): never {
  console.error(`\n[config] ${message}\n`);
  process.exit(1);
}

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  fail(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n[config] '));
}
const env = parsed.data;
const isProduction = env.NODE_ENV === 'production';

try {
  new Intl.DateTimeFormat('en-US', { timeZone: env.TIME_ZONE });
} catch {
  fail(`TIME_ZONE "${env.TIME_ZONE}" is not a valid IANA time zone (e.g. Asia/Kolkata).`);
}

const dataDir = path.resolve(ROOT_DIR, env.DATA_DIR);

/** "/compass" (no trailing slash), or "" to serve from the site root. */
function resolveBasePath(): string {
  const value = `/${env.BASE_PATH.trim().replace(/^\/+|\/+$/g, '')}`;
  if (value === '/') return '';
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(value)) fail(`BASE_PATH "${env.BASE_PATH}" is not a valid URL path (e.g. /compass).`);
  return value;
}

/** Signs parent share links. Required in production; generated once and kept on disk in development. */
function resolveAppSecret(): string {
  if (env.APP_SECRET) {
    if (env.APP_SECRET.length < 32) fail('APP_SECRET must be at least 32 characters.');
    return env.APP_SECRET;
  }
  if (isProduction) fail('APP_SECRET is required in production (32+ random characters).');
  const file = path.join(dataDir, '.app-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** The site's origin, without a path: links add BASE_PATH themselves. */
function resolvePublicBaseUrl(): string {
  const value = env.PUBLIC_BASE_URL ?? (isProduction ? undefined : `http://localhost:${env.PORT}`);
  if (!value) fail('PUBLIC_BASE_URL is required in production (the https site address parents open report links on).');
  let url: URL;
  try {
    url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
  } catch {
    return fail(`PUBLIC_BASE_URL "${value}" is not a valid http(s) URL.`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    fail(`PUBLIC_BASE_URL "${value}" must be the site address only (e.g. https://www.brainastra.com); BASE_PATH adds the path.`);
  }
  return url.origin;
}

const basePath = resolveBasePath();
const publicBaseUrl = resolvePublicBaseUrl();

function isPubliclyReachable(base: string): boolean {
  const host = new URL(base).hostname;
  return !(
    host === 'localhost' ||
    host.endsWith('.local') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

if (isProduction && !env.S3_BUCKET) {
  fail('S3_BUCKET is required in production, so report files survive a redeploy or a new server.');
}
if (env.EMAIL_MODE !== 'preview' && !env.MAIL_FROM) {
  fail(`MAIL_FROM is required when EMAIL_MODE=${env.EMAIL_MODE} (a sender verified in SES, e.g. "Shichida India <noreply@example.org>").`);
}
if (env.EMAIL_MODE === 'smtp' && !env.SMTP_HOST) fail('SMTP_HOST is required when EMAIL_MODE=smtp.');
if (env.SMTP_HOST && !env.SMTP_USER !== !env.SMTP_PASS) {
  fail('Set both SMTP_USER and SMTP_PASS, or neither (for an unauthenticated relay).');
}
if (!env.WHATSAPP_PHONE_NUMBER_ID !== !env.WHATSAPP_ACCESS_TOKEN) {
  fail('Set both WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN to use the WhatsApp Cloud API, or neither.');
}
if (env.INTERNAL_WEBHOOK_URL) {
  try {
    new URL(env.INTERNAL_WEBHOOK_URL);
  } catch {
    fail('INTERNAL_WEBHOOK_URL is not a valid URL.');
  }
  if (!env.INTERNAL_WEBHOOK_SECRET) fail('INTERNAL_WEBHOOK_SECRET is required when INTERNAL_WEBHOOK_URL is set.');
}

const s3Prefix = env.S3_PREFIX.trim().replace(/^\/+|\/+$/g, '');

export const config = {
  env: env.NODE_ENV,
  isProduction,
  appEnv: env.APP_ENV,
  host: env.HOST,
  port: env.PORT,
  basePath,
  rootDir: ROOT_DIR,
  dataDir,
  assetsDir: path.join(ROOT_DIR, 'server', 'assets'),
  aws: { region: env.AWS_REGION, dynamodbEndpoint: env.DYNAMODB_ENDPOINT ?? null },
  tablePrefix: env.DYNAMODB_TABLE_PREFIX ?? `EarlyCompass-${env.APP_ENV}`,
  s3: env.S3_BUCKET ? { bucket: env.S3_BUCKET, prefix: s3Prefix ? `${s3Prefix}/` : '' } : null,
  appSecret: resolveAppSecret(),
  publicBaseUrl,
  publicLinksReachable: isPubliclyReachable(publicBaseUrl),
  timeZone: env.TIME_ZONE,
  sessionHours: env.SESSION_HOURS,
  reportLinkDays: env.REPORT_LINK_DAYS,
  cookieSecure: env.COOKIE_SECURE === 'auto' ? publicBaseUrl.startsWith('https://') : env.COOKIE_SECURE === 'true',
  trustProxy: env.TRUST_PROXY,
  centres: env.CENTRES.split(/[,;\n]/).map((c) => c.trim()).filter(Boolean),
  contact: { email: env.ORG_SUPPORT_EMAIL, phone: env.ORG_SUPPORT_PHONE, website: env.ORG_WEBSITE },
  bootstrapAdmin:
    env.ADMIN_EMAIL && env.ADMIN_PASSWORD
      ? { email: env.ADMIN_EMAIL.toLowerCase(), password: env.ADMIN_PASSWORD, name: env.ADMIN_NAME ?? 'Administrator' }
      : null,
  emailMode: env.EMAIL_MODE,
  sesConfigurationSet: env.SES_CONFIGURATION_SET ?? null,
  smtp: env.SMTP_HOST
    ? {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      }
    : null,
  mailFrom: env.MAIL_FROM ?? 'Shichida India <reports@localhost>',
  mailReplyTo: env.MAIL_REPLY_TO ?? null,
  whatsapp:
    env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN
      ? {
          phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
          accessToken: env.WHATSAPP_ACCESS_TOKEN,
          apiVersion: env.WHATSAPP_API_VERSION,
          templateName: env.WHATSAPP_TEMPLATE_NAME ?? null,
          templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE,
        }
      : null,
  webhook:
    env.INTERNAL_WEBHOOK_URL && env.INTERNAL_WEBHOOK_SECRET
      ? { url: env.INTERNAL_WEBHOOK_URL, secret: env.INTERNAL_WEBHOOK_SECRET }
      : null,
} as const;

export type AppConfig = typeof config;
