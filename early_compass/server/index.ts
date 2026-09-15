import { createApp } from './app';
import { config } from './config';
import { setupTables, verifyTables } from './db';
import { users } from './repo';
import { hashPassword } from './security';
import { emailMode, verifyEmailTransport } from './services/email';
import { startSyncRetryLoop, syncEnabled } from './services/sync';
import { whatsappMode } from './services/whatsapp';

// Deploys create and update tables with `npm run db:setup` before restarting; in development
// the tables are created on start.
if (config.isProduction) await verifyTables();
else await setupTables((message) => console.log(`[db] ${message}`));

if ((await users.count()) === 0) {
  if (config.bootstrapAdmin) {
    const { email, name, password } = config.bootstrapAdmin;
    await users.create({ email, name, role: 'admin', centre: '', passwordHash: await hashPassword(password) });
    console.log(`[setup] Created administrator ${email} from ADMIN_EMAIL / ADMIN_PASSWORD`);
  } else {
    console.warn('[setup] No staff accounts exist. Create one with: npm run user:create -- --email <email> --name "<name>" --role admin');
  }
}

const emailLabel = { ses: `Amazon SES from ${config.mailFrom}`, smtp: 'SMTP', preview: 'preview mode (EMAIL_MODE=preview)' }[emailMode];

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  console.log(
    [
      `[ready] Shichida India Early Compass API on http://${config.host}:${config.port}${config.basePath} (${config.env})`,
      `        tables: ${config.tablePrefix}-*${config.aws.dynamodbEndpoint ? ` at ${config.aws.dynamodbEndpoint}` : ''} · files: ${config.s3 ? `s3://${config.s3.bucket}/${config.s3.prefix}` : config.dataDir}`,
      `        report links: ${config.publicBaseUrl}${config.basePath}/r/…${config.publicLinksReachable ? '' : '  (not reachable from parents’ phones — set PUBLIC_BASE_URL)'}`,
      `        email: ${emailLabel} · WhatsApp: ${whatsappMode === 'cloud_api' ? 'Cloud API' : 'click-to-chat'} · internal sync: ${syncEnabled ? 'on' : 'off'}`,
    ].join('\n'),
  );
});

void verifyEmailTransport();
startSyncRetryLoop();

function shutdown(signal: string) {
  console.log(`[shutdown] ${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
