/**
 * Creates or updates the DynamoDB tables for this environment and seeds the checklist once.
 * Safe to run any number of times; every deploy runs it before restarting the API.
 *
 *   npm run db:setup                      (tables for APP_ENV, e.g. EarlyCompass-dev-*)
 *   node dist/scripts/db-setup.js         (on the server, from a release)
 */
import { config } from '../server/config';
import { setupTables } from '../server/db';

console.log(`[db] ${config.tablePrefix}-* in ${config.aws.region}${config.aws.dynamodbEndpoint ? ` at ${config.aws.dynamodbEndpoint}` : ''}`);
await setupTables((message) => console.log(`[db] ${message}`));
console.log('[db] tables ready');
