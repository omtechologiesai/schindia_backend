/**
 * DynamoDB tables, named "<prefix>-<Table>": EarlyCompass-dev-* for local development and staging,
 * EarlyCompass-production-* for production, kept apart from the Shichida admin app's tables. All use
 * on-demand billing.
 *
 * setupTables() is idempotent and runs on every deploy: it creates missing tables, adds missing
 * indexes to tables that already exist (one at a time, as DynamoDB requires), turns on session
 * expiry, turns on point-in-time recovery in production, and seeds the original 480-question
 * checklist once.
 */
import {
  CreateTableCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  UpdateContinuousBackupsCommand,
  UpdateTableCommand,
  UpdateTimeToLiveCommand,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type KeySchemaElement,
  type TableDescription,
} from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
  type QueryCommandInput,
  type ScanCommandInput,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { seedChecklist } from '@shared/checklist';
import { BANDS, DOMAIN_ORDER, type DomainKey } from '@shared/domain';
import { ddb, dynamodb } from './aws';
import { config } from './config';

const tableName = (table: string) => `${config.tablePrefix}-${table}`;

export const TABLES = {
  users: tableName('Users'),
  sessions: tableName('Sessions'),
  children: tableName('Children'),
  assessments: tableName('Assessments'),
  deliveries: tableName('Deliveries'),
  checklist: tableName('Checklist'),
  /** Counters (assessment references, checklist revision), unique-email guards and the seed marker. */
  meta: tableName('Meta'),
} as const;

export const INDEX = {
  sessionsByUser: 'user_id-index',
  assessmentsByChild: 'child_id-assessed_at-index',
  assessmentsByDate: 'list_pk-assessed_at-index',
  deliveriesByAssessment: 'assessment_id-created_at-index',
} as const;

/** Every assessment carries list_pk = "all", so one query of the by-date index lists them newest first. */
export const ALL_ASSESSMENTS = 'all';

/** The columns an assessment list needs; the by-date index carries only these, never the answer JSON. */
const ASSESSMENT_SUMMARY_COLUMNS = [
  'reference',
  'child_id',
  'age_months',
  'band',
  'overall_pct',
  'target_pct',
  'assessor_name',
  'report_version',
  'stats_json',
  'created_at',
];

/** Sort key of a checklist question within its band: "language#0007". Numbers are never reused. */
export const checklistItemKey = (domain: DomainKey, number: number) => `${domain}#${String(number).padStart(4, '0')}`;

interface TableSpec {
  name: string;
  key: KeySchemaElement[];
  attributes: AttributeDefinition[];
  indexes: GlobalSecondaryIndex[];
  /** Attribute holding an epoch-seconds expiry, for DynamoDB to delete expired items. */
  expiry?: string;
}

const hash = (AttributeName: string): KeySchemaElement => ({ AttributeName, KeyType: 'HASH' });
const range = (AttributeName: string): KeySchemaElement => ({ AttributeName, KeyType: 'RANGE' });
const text = (AttributeName: string): AttributeDefinition => ({ AttributeName, AttributeType: 'S' });

const SPECS: TableSpec[] = [
  { name: TABLES.users, key: [hash('id')], attributes: [text('id')], indexes: [] },
  {
    name: TABLES.sessions,
    key: [hash('id')],
    attributes: [text('id'), text('user_id')],
    indexes: [{ IndexName: INDEX.sessionsByUser, KeySchema: [hash('user_id')], Projection: { ProjectionType: 'KEYS_ONLY' } }],
    expiry: 'expires_epoch',
  },
  { name: TABLES.children, key: [hash('id')], attributes: [text('id')], indexes: [] },
  {
    name: TABLES.assessments,
    key: [hash('id')],
    attributes: [text('id'), text('child_id'), text('assessed_at'), text('list_pk')],
    indexes: [
      {
        IndexName: INDEX.assessmentsByChild,
        KeySchema: [hash('child_id'), range('assessed_at')],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: INDEX.assessmentsByDate,
        KeySchema: [hash('list_pk'), range('assessed_at')],
        Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ASSESSMENT_SUMMARY_COLUMNS },
      },
    ],
  },
  {
    name: TABLES.deliveries,
    key: [hash('id')],
    attributes: [text('id'), text('assessment_id'), text('created_at')],
    indexes: [
      {
        IndexName: INDEX.deliveriesByAssessment,
        KeySchema: [hash('assessment_id'), range('created_at')],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  { name: TABLES.checklist, key: [hash('band'), range('item_key')], attributes: [text('band'), text('item_key')], indexes: [] },
  { name: TABLES.meta, key: [hash('pk')], attributes: [text('pk')], indexes: [] },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function describe(name: string): Promise<TableDescription | undefined> {
  try {
    return (await dynamodb.send(new DescribeTableCommand({ TableName: name }))).Table;
  } catch (error) {
    if ((error as { name?: string }).name === 'ResourceNotFoundException') return undefined;
    throw error;
  }
}

async function waitUntilReady(name: string): Promise<void> {
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    const table = await describe(name);
    const indexesReady = (table?.GlobalSecondaryIndexes ?? []).every((index) => !index.IndexStatus || index.IndexStatus === 'ACTIVE');
    if (table?.TableStatus === 'ACTIVE' && indexesReady) return;
    if (Date.now() > deadline) throw new Error(`${name} did not become ready within 20 minutes`);
    await sleep(config.aws.dynamodbEndpoint ? 100 : 3_000);
  }
}

async function enableExpiry(name: string, attribute: string): Promise<void> {
  const current = await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: name }));
  const status = current.TimeToLiveDescription?.TimeToLiveStatus;
  if (status === 'ENABLED' || status === 'ENABLING') return;
  await dynamodb.send(new UpdateTimeToLiveCommand({ TableName: name, TimeToLiveSpecification: { AttributeName: attribute, Enabled: true } }));
}

async function enablePointInTimeRecovery(name: string): Promise<boolean> {
  // A table created moments ago refuses this ("Backups are being enabled for the table… retry
  // later") until DynamoDB has finished preparing it, which can take a few minutes.
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const current = await dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: name }));
    if (current.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus === 'ENABLED') return false;
    try {
      await dynamodb.send(
        new UpdateContinuousBackupsCommand({ TableName: name, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }),
      );
      return true;
    } catch (error) {
      if ((error as { name?: string }).name !== 'ContinuousBackupsUnavailableException' || Date.now() > deadline) throw error;
      await sleep(15_000);
    }
  }
}

export async function setupTables(log: (message: string) => void = () => {}): Promise<void> {
  for (const spec of SPECS) {
    const existing = await describe(spec.name);
    if (!existing) {
      await dynamodb.send(
        new CreateTableCommand({
          TableName: spec.name,
          KeySchema: spec.key,
          AttributeDefinitions: spec.attributes,
          BillingMode: 'PAY_PER_REQUEST',
          ...(spec.indexes.length ? { GlobalSecondaryIndexes: spec.indexes } : {}),
        }),
      );
      log(`created ${spec.name}`);
      await waitUntilReady(spec.name);
    } else {
      const present = new Set((existing.GlobalSecondaryIndexes ?? []).map((index) => index.IndexName));
      for (const index of spec.indexes) {
        if (present.has(index.IndexName)) continue;
        const keyNames = new Set(index.KeySchema!.map((key) => key.AttributeName));
        await dynamodb.send(
          new UpdateTableCommand({
            TableName: spec.name,
            AttributeDefinitions: spec.attributes.filter((attribute) => keyNames.has(attribute.AttributeName)),
            GlobalSecondaryIndexUpdates: [{ Create: index }],
          }),
        );
        log(`adding index ${index.IndexName} to ${spec.name} (existing items are backfilled; this can take a few minutes)`);
        await waitUntilReady(spec.name);
      }
    }
    if (spec.expiry) await enableExpiry(spec.name, spec.expiry);
  }
  await seedChecklistOnce(log);
  // Last, so new tables have had time to become eligible for backups.
  if (config.appEnv === 'production' && !config.aws.dynamodbEndpoint) {
    for (const spec of SPECS) {
      if (await enablePointInTimeRecovery(spec.name)) log(`turned on point-in-time recovery for ${spec.name}`);
    }
  }
}

/** For production start-up: the process never creates tables, but refuses to run without them. */
export async function verifyTables(): Promise<void> {
  const missing: string[] = [];
  for (const spec of SPECS) {
    const table = await describe(spec.name);
    const indexes = new Set((table?.GlobalSecondaryIndexes ?? []).map((index) => index.IndexName));
    if (!table || spec.indexes.some((index) => !indexes.has(index.IndexName))) missing.push(spec.name);
  }
  if (missing.length) throw new Error(`DynamoDB tables or indexes are missing: ${missing.join(', ')}. Run: npm run db:setup`);
}

const SEED_MARKER = 'seed#checklist';

/** The original 480 milestones, keeping their "band:domain:number" ids so earlier answers still match. */
async function seedChecklistOnce(log: (message: string) => void): Promise<void> {
  const marker = await ddb.send(new GetCommand({ TableName: TABLES.meta, Key: { pk: SEED_MARKER }, ConsistentRead: true }));
  if (marker.Item) return;
  const seed = seedChecklist();
  const ts = new Date().toISOString();
  const items = BANDS.flatMap((band) =>
    DOMAIN_ORDER.flatMap((domain) =>
      seed[band][domain].map((item, index) => ({
        band,
        item_key: checklistItemKey(domain, index + 1),
        id: item.id,
        domain,
        number: index + 1,
        position: index + 1,
        text: item.text,
        created_at: ts,
      })),
    ),
  );
  await batchWrite(TABLES.checklist, items.map((item) => ({ put: item })));
  await ddb.send(new PutCommand({ TableName: TABLES.meta, Item: { pk: SEED_MARKER, seeded_at: ts, items: items.length } }));
  log(`seeded ${items.length} checklist questions`);
}

/* -------------------------------------------------------------- helpers */

export async function scanAll<T>(input: ScanCommandInput): Promise<T[]> {
  const items: T[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ ...input, ExclusiveStartKey }));
    items.push(...((page.Items ?? []) as T[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export async function queryAll<T>(input: QueryCommandInput): Promise<T[]> {
  const items: T[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...((page.Items ?? []) as T[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

export type WriteRequest = { put: Record<string, unknown> } | { delete: Record<string, unknown> };
type RequestItems = NonNullable<BatchWriteCommandInput['RequestItems']>;

/** Batches of 25, retrying whatever DynamoDB leaves unprocessed. */
export async function batchWrite(table: string, requests: WriteRequest[]): Promise<void> {
  for (let start = 0; start < requests.length; start += 25) {
    let pending: RequestItems = {
      [table]: requests
        .slice(start, start + 25)
        .map((request) => ('put' in request ? { PutRequest: { Item: request.put } } : { DeleteRequest: { Key: request.delete } })),
    };
    for (let attempt = 0; Object.keys(pending).length > 0; attempt++) {
      if (attempt > 8) throw new Error(`DynamoDB kept deferring writes to ${table}`);
      if (attempt > 0) await sleep(2 ** attempt * 50);
      const result = await ddb.send(new BatchWriteCommand({ RequestItems: pending }));
      pending = (result.UnprocessedItems ?? {}) as RequestItems;
    }
  }
}

const counterKey = (name: string) => ({ pk: `counter#${name}` });

/** Atomically adds one and returns the new value; the first call returns 1. */
export async function nextCounter(name: string): Promise<number> {
  const result = await ddb.send(
    new UpdateCommand({
      TableName: TABLES.meta,
      Key: counterKey(name),
      UpdateExpression: 'ADD #value :one',
      ExpressionAttributeNames: { '#value': 'value' },
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(result.Attributes?.value);
}

export async function readCounter(name: string): Promise<number | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: TABLES.meta, Key: counterKey(name), ConsistentRead: true }));
  return result.Item ? Number(result.Item.value) : undefined;
}

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** The same increment as nextCounter, as one step of a transaction. */
export function counterIncrement(name: string): TransactItem {
  return {
    Update: {
      TableName: TABLES.meta,
      Key: counterKey(name),
      UpdateExpression: 'ADD #value :one',
      ExpressionAttributeNames: { '#value': 'value' },
      ExpressionAttributeValues: { ':one': 1 },
    },
  };
}

/** A conditional write that didn't apply, on its own or as part of a cancelled transaction. */
export function isConditionFailure(error: unknown): boolean {
  const failure = error as { name?: string; message?: string; CancellationReasons?: { Code?: string }[] } | null;
  if (failure?.name === 'ConditionalCheckFailedException') return true;
  if (failure?.name === 'TransactionCanceledException') {
    return (
      (failure.CancellationReasons ?? []).some((reason) => reason.Code === 'ConditionalCheckFailed') ||
      /ConditionalCheckFailed/.test(failure.message ?? '')
    );
  }
  return false;
}
