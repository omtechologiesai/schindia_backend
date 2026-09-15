/**
 * Create a staff account, or reset an existing account's password, from the command line.
 *
 *   npm run user:create -- --email priya@example.org --name "Priya Nair" --role admin --centre "Indiranagar"
 *   npm run user:create -- --email priya@example.org --reset
 *
 * A strong password is generated and printed unless --password is given. The account goes into the
 * tables for APP_ENV (EarlyCompass-dev-* locally and on staging).
 */
import { parseArgs } from 'node:util';
import { createUserSchema, fieldErrors } from '@shared/schemas';
import { config } from '../server/config';
import { verifyTables } from '../server/db';
import { sessions, users } from '../server/repo';
import { hashPassword, randomToken } from '../server/security';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', default: 'staff' },
    centre: { type: 'string', default: '' },
    password: { type: 'string' },
    reset: { type: 'boolean', default: false },
  },
});

function exit(message: string): never {
  console.error(message);
  process.exit(1);
}

await verifyTables();

const email = (values.email ?? '').trim().toLowerCase();
if (!email) exit('Usage: npm run user:create -- --email <email> --name "<name>" [--role admin|staff] [--centre "<centre>"] [--password <pw>] [--reset]');
const password = values.password ?? randomToken(12);

if (values.reset) {
  const user = await users.byEmail(email);
  if (!user) exit(`No staff account exists for ${email} in ${config.tablePrefix}.`);
  if (password.length < 10) exit('Password must be at least 10 characters.');
  await users.update(user.id, { passwordHash: await hashPassword(password), active: true });
  await sessions.deleteForUser(user.id);
  console.log(`Password reset for ${email} (${config.tablePrefix})\nNew password: ${password}`);
} else {
  const parsed = createUserSchema.safeParse({ email, name: values.name ?? '', role: values.role, centre: values.centre, password });
  if (!parsed.success) {
    exit(Object.entries(fieldErrors(parsed.error)).map(([field, message]) => `${field}: ${message}`).join('\n'));
  }
  if (await users.byEmail(parsed.data.email)) exit(`An account for ${email} already exists. Use --reset to set a new password.`);
  await users.create({
    email: parsed.data.email,
    name: parsed.data.name,
    role: parsed.data.role,
    centre: parsed.data.centre,
    passwordHash: await hashPassword(parsed.data.password),
  });
  console.log(`Created ${parsed.data.role} account for ${parsed.data.name} <${parsed.data.email}> in ${config.tablePrefix}\nPassword: ${password}`);
}
