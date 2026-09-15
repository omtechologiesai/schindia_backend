/**
 * Data access on DynamoDB (tables and helpers in db.ts). Rows keep the column names and shapes of
 * the original SQLite schema so the services above barely change: JSON columns are stored as
 * strings and booleans as 1/0.
 *
 * Lists and searches read a whole table and filter in the process, which suits workshop scale (a
 * few thousand records). Assessment lists read the by-date index, which carries only the summary
 * columns and never the large answer JSON.
 */
import crypto from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type {
  AssessmentListItemDTO,
  ChildDTO,
  ChildListItemDTO,
  DeliveryChannel,
  DeliveryDTO,
  DeliveryMode,
  DeliveryStatus,
  GoalResponseDTO,
  ReadingSummaryDTO,
  ResponseItemDTO,
  Role,
  SyncStatus,
  UserDTO,
} from '@shared/api';
import { emptyBandItems, type BandItems, type Checklist, type ChecklistItem } from '@shared/checklist';
import type { InterestKey } from '@shared/data/activities';
import { CHECKLIST_VERSION } from '@shared/data/checklist';
import type { GoalAge } from '@shared/data/goals';
import { BANDS, itemId, type BandKey, type DomainKey } from '@shared/domain';
import { zonedParts } from '@shared/format';
import type { ChildDetails, Gender, ParentContact, Relation } from '@shared/schemas';
import type { Commentary, DomainStats, FocusAreaDetail } from '@shared/scoring';
import { ddb } from './aws';
import { config } from './config';
import {
  ALL_ASSESSMENTS,
  batchWrite,
  checklistItemKey,
  counterIncrement,
  INDEX,
  isConditionFailure,
  nextCounter,
  queryAll,
  readCounter,
  scanAll,
  TABLES,
} from './db';

const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
const bit = (value: boolean) => (value ? 1 : 0);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A write that lost to another one: a duplicate email, a question number just taken, a record just deleted. */
export class ConflictError extends Error {
  override name = 'ConflictError';
}

async function getItem<T>(table: string, key: Record<string, unknown>): Promise<T | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  return result.Item as T | undefined;
}

/**
 * Sets fields on an existing item and returns whether it existed. A missing item is left alone, as an
 * SQL UPDATE of a deleted row would be; an unconditional update would recreate part of it.
 */
async function setFields(table: string, key: Record<string, string>, fields: object): Promise<boolean> {
  // Key attributes can't be SET, even to their current value.
  const entries = Object.entries(fields).filter(([field, value]) => !(field in key) && value !== undefined);
  const [keyName] = Object.keys(key);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression: `SET ${entries.map((_, i) => `#f${i} = :v${i}`).join(', ')}`,
        ConditionExpression: 'attribute_exists(#key)',
        ExpressionAttributeNames: { '#key': keyName!, ...Object.fromEntries(entries.map(([field], i) => [`#f${i}`, field])) },
        ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], i) => [`:v${i}`, value])),
      }),
    );
    return true;
  } catch (error) {
    if (isConditionFailure(error)) return false;
    throw error;
  }
}

/* ---------------------------------------------------------------- users */

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  centre: string;
  password_hash: string;
  active: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export function toUserDTO(row: UserRow): UserDTO {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    centre: row.centre,
    active: row.active === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

/** Meta item that reserves an email for one account, and points at it for sign-in. */
const emailGuardKey = (email: string) => ({ pk: `user-email#${email.toLowerCase()}` });

export const users = {
  async count(): Promise<number> {
    return (await users.list()).length;
  },
  async activeAdminCount(): Promise<number> {
    return (await users.list()).filter((user) => user.role === 'admin' && user.active === 1).length;
  },
  byId(id: string): Promise<UserRow | undefined> {
    return getItem<UserRow>(TABLES.users, { id });
  },
  async byEmail(email: string): Promise<UserRow | undefined> {
    const guard = await getItem<{ user_id: string }>(TABLES.meta, emailGuardKey(email));
    return guard ? users.byId(guard.user_id) : undefined;
  },
  async list(): Promise<UserRow[]> {
    const rows = await scanAll<UserRow>({ TableName: TABLES.users, ConsistentRead: true });
    return rows.sort((a, b) => b.active - a.active || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  },
  async create(input: { email: string; name: string; role: Role; centre: string; passwordHash: string }): Promise<UserRow> {
    const ts = nowIso();
    const row: UserRow = {
      id: newId(),
      email: input.email,
      name: input.name,
      role: input.role,
      centre: input.centre,
      password_hash: input.passwordHash,
      active: 1,
      created_at: ts,
      updated_at: ts,
      last_login_at: null,
    };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLES.meta,
                Item: { ...emailGuardKey(row.email), user_id: row.id },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            { Put: { TableName: TABLES.users, Item: row } },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new ConflictError('A staff account with that email already exists.');
      throw error;
    }
    return row;
  },
  async update(
    id: string,
    patch: { name?: string; role?: Role; centre?: string; active?: boolean; passwordHash?: string },
  ): Promise<UserRow | undefined> {
    const current = await users.byId(id);
    if (!current) return undefined;
    const row: UserRow = {
      ...current,
      name: patch.name ?? current.name,
      role: patch.role ?? current.role,
      centre: patch.centre ?? current.centre,
      active: patch.active === undefined ? current.active : bit(patch.active),
      password_hash: patch.passwordHash ?? current.password_hash,
      updated_at: nowIso(),
    };
    return (await setFields(TABLES.users, { id }, row)) ? row : undefined;
  },
  async recordLogin(id: string): Promise<void> {
    await setFields(TABLES.users, { id }, { last_login_at: nowIso() });
  },
};

/* ------------------------------------------------------------- sessions */

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

const epochSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** Expired sessions are deleted by DynamoDB (expiry on expires_epoch); findValid checks the time itself. */
export const sessions = {
  async create(input: { id: string; userId: string; expiresAt: string; userAgent: string; ip: string }): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLES.sessions,
        Item: {
          id: input.id,
          user_id: input.userId,
          created_at: nowIso(),
          expires_at: input.expiresAt,
          expires_epoch: epochSeconds(input.expiresAt),
          user_agent: input.userAgent,
          ip: input.ip,
        },
      }),
    );
  },
  async findValid(id: string): Promise<SessionRow | undefined> {
    const row = await getItem<SessionRow>(TABLES.sessions, { id });
    return row && row.expires_at > nowIso() ? row : undefined;
  },
  async extend(id: string, expiresAt: string): Promise<void> {
    await setFields(TABLES.sessions, { id }, { expires_at: expiresAt, expires_epoch: epochSeconds(expiresAt) });
  },
  async delete(id: string): Promise<void> {
    await ddb.send(new DeleteCommand({ TableName: TABLES.sessions, Key: { id } }));
  },
  async deleteForUser(userId: string): Promise<void> {
    const rows = await queryAll<{ id: string }>({
      TableName: TABLES.sessions,
      IndexName: INDEX.sessionsByUser,
      KeyConditionExpression: 'user_id = :user',
      ExpressionAttributeValues: { ':user': userId },
    });
    await batchWrite(TABLES.sessions, rows.map((row) => ({ delete: { id: row.id } })));
  },
};

/* ------------------------------------------------------------- children */

export interface ChildRow {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: Gender | null;
  centre: string;
  parent_name: string;
  parent_relation: Relation;
  parent_phone: string;
  parent_email: string;
  consent_at: string;
  consent_by: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function toChildDTO(row: ChildRow): ChildDTO {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    dateOfBirth: row.date_of_birth,
    gender: row.gender,
    centre: row.centre,
    parent: { name: row.parent_name, relation: row.parent_relation, phone: row.parent_phone, email: row.parent_email },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Child and parent details for writing; parent.phone must already be E.164. */
export interface ChildWrite {
  child: ChildDetails;
  parent: ParentContact;
}

function childColumns({ child, parent }: ChildWrite) {
  return {
    first_name: child.firstName,
    last_name: child.lastName,
    date_of_birth: child.dateOfBirth,
    gender: child.gender,
    centre: child.centre,
    parent_name: parent.name,
    parent_relation: parent.relation,
    parent_phone: parent.phone,
    parent_email: parent.email,
  };
}

/** Name, parent name, email, or 4+ digits of the mobile number: a case-insensitive "contains", as the SQL LIKE was. */
function childMatcher(q: string): ((row: ChildRow) => boolean) | null {
  const term = q.trim().toLowerCase();
  if (!term) return null;
  const digits = term.replace(/\D/g, '');
  return (row) =>
    `${row.first_name} ${row.last_name}`.toLowerCase().includes(term) ||
    row.parent_name.toLowerCase().includes(term) ||
    row.parent_email.toLowerCase().includes(term) ||
    (digits.length >= 4 && row.parent_phone.includes(digits));
}

export const children = {
  byId(id: string): Promise<ChildRow | undefined> {
    return getItem<ChildRow>(TABLES.children, { id });
  },
  /** A new child's row, not yet saved: assessments.create saves it together with the first assessment. */
  build(input: ChildWrite & { userId: string }): ChildRow {
    const ts = nowIso();
    return {
      id: newId(),
      ...childColumns(input),
      consent_at: ts,
      consent_by: input.userId,
      created_by: input.userId,
      created_at: ts,
      updated_at: ts,
    };
  },
  /** The row with corrected details, not yet saved. Passing consentUserId re-records consent (it was just given again). */
  merge(current: ChildRow, input: ChildWrite & { consentUserId?: string }): ChildRow {
    const ts = nowIso();
    return {
      ...current,
      ...childColumns(input),
      updated_at: ts,
      ...(input.consentUserId ? { consent_at: ts, consent_by: input.consentUserId } : {}),
    };
  },
  async update(id: string, input: ChildWrite & { consentUserId?: string }): Promise<ChildRow | undefined> {
    const current = await children.byId(id);
    if (!current) return undefined;
    const row = children.merge(current, input);
    return (await setFields(TABLES.children, { id }, row)) ? row : undefined;
  },
  async list(options: { q: string; limit: number; offset: number }): Promise<{ items: ChildListItemDTO[]; total: number }> {
    const [rows, summaries] = await Promise.all([
      scanAll<ChildRow>({ TableName: TABLES.children, ConsistentRead: true }),
      assessments.summaries(),
    ]);
    const history = new Map<string, { count: number; latest: AssessmentSummaryRow }>();
    for (const summary of summaries) {
      const entry = history.get(summary.child_id);
      if (entry) entry.count++;
      else history.set(summary.child_id, { count: 1, latest: summary });
    }
    const matches = childMatcher(options.q);
    const listed = (matches ? rows.filter(matches) : rows)
      .map((row) => ({ row, entry: history.get(row.id) }))
      .sort((a, b) => (b.entry?.latest.assessed_at ?? b.row.created_at).localeCompare(a.entry?.latest.assessed_at ?? a.row.created_at));
    return {
      total: listed.length,
      items: listed.slice(options.offset, options.offset + options.limit).map(({ row, entry }) => ({
        ...toChildDTO(row),
        assessmentCount: entry?.count ?? 0,
        lastAssessment: entry ? toReadingSummary(entry.latest) : null,
      })),
    };
  },
  async delete(id: string): Promise<void> {
    await ddb.send(new DeleteCommand({ TableName: TABLES.children, Key: { id } }));
  },
};

/* ---------------------------------------------------------- assessments */

export interface AssessmentRow {
  id: string;
  reference: string;
  child_id: string;
  assessed_at: string;
  age_months: number;
  band: BandKey;
  band_overridden: number;
  checklist_version: string;
  child_snapshot_json: string;
  responses_json: string;
  goals_json: string | null;
  interests_json: string;
  stats_json: string;
  overall_pct: number;
  auto_target_pct: number;
  target_pct: number;
  target_is_custom: number;
  focus_json: string;
  commentary_json: string;
  previous_json: string | null;
  notes: string;
  assessor_id: string;
  assessor_name: string;
  report_version: number;
  report_generated_at: string | null;
  report_error: string | null;
  share_nonce: string;
  share_expires_at: string;
  sync_status: SyncStatus;
  sync_attempts: number;
  sync_error: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the by-date index returns for each assessment. */
export type AssessmentSummaryRow = Pick<
  AssessmentRow,
  | 'id'
  | 'reference'
  | 'child_id'
  | 'assessed_at'
  | 'age_months'
  | 'band'
  | 'overall_pct'
  | 'target_pct'
  | 'assessor_name'
  | 'report_version'
  | 'stats_json'
  | 'created_at'
>;

/** The parsed JSON columns of an assessment. */
export interface AssessmentDetail {
  child: ChildDTO;
  responses: ResponseItemDTO[];
  goals: { age: GoalAge; items: GoalResponseDTO[] } | null;
  interests: InterestKey[];
  stats: DomainStats;
  focusAreas: FocusAreaDetail[];
  commentary: Commentary;
  previous: ReadingSummaryDTO | null;
}

export function parseAssessment(row: AssessmentRow): AssessmentDetail {
  return {
    child: JSON.parse(row.child_snapshot_json) as ChildDTO,
    responses: JSON.parse(row.responses_json) as ResponseItemDTO[],
    goals: row.goals_json ? (JSON.parse(row.goals_json) as AssessmentDetail['goals']) : null,
    interests: JSON.parse(row.interests_json) as InterestKey[],
    stats: JSON.parse(row.stats_json) as DomainStats,
    focusAreas: JSON.parse(row.focus_json) as FocusAreaDetail[],
    commentary: JSON.parse(row.commentary_json) as Commentary,
    previous: row.previous_json ? (JSON.parse(row.previous_json) as ReadingSummaryDTO) : null,
  };
}

export function toReadingSummary(
  row: Pick<AssessmentRow, 'id' | 'reference' | 'assessed_at' | 'age_months' | 'band' | 'stats_json' | 'overall_pct' | 'target_pct'>,
): ReadingSummaryDTO {
  return {
    id: row.id,
    reference: row.reference,
    assessedAt: row.assessed_at,
    ageMonths: row.age_months,
    band: row.band,
    stats: JSON.parse(row.stats_json) as DomainStats,
    overallPct: row.overall_pct,
    targetPct: row.target_pct,
  };
}

export interface NewAssessment extends AssessmentDetail {
  childId: string;
  assessedAt: string;
  ageMonths: number;
  band: BandKey;
  bandOverridden: boolean;
  checklistVersion: string;
  overallPct: number;
  autoTargetPct: number;
  targetPct: number;
  targetIsCustom: boolean;
  notes: string;
  assessorId: string;
  assessorName: string;
  shareNonce: string;
  shareExpiresAt: string;
  syncStatus: SyncStatus;
}

/**
 * "EC-2026-00042": sequential per year in the configured time zone. The number is taken before the
 * record is written, so a save that fails leaves a gap in the series.
 */
async function nextReference(at: Date): Promise<string> {
  const year = zonedParts(at, config.timeZone).year;
  const value = await nextCounter(`assessment-${year}`);
  return `EC-${year}-${String(value).padStart(5, '0')}`;
}

export const assessments = {
  byId(id: string): Promise<AssessmentRow | undefined> {
    return getItem<AssessmentRow>(TABLES.assessments, { id });
  },
  async latestForChild(childId: string): Promise<AssessmentRow | undefined> {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLES.assessments,
        IndexName: INDEX.assessmentsByChild,
        KeyConditionExpression: 'child_id = :child',
        ExpressionAttributeValues: { ':child': childId },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );
    return result.Items?.[0] as AssessmentRow | undefined;
  },
  forChild(childId: string): Promise<AssessmentRow[]> {
    return queryAll<AssessmentRow>({
      TableName: TABLES.assessments,
      IndexName: INDEX.assessmentsByChild,
      KeyConditionExpression: 'child_id = :child',
      ExpressionAttributeValues: { ':child': childId },
      ScanIndexForward: false,
    });
  },
  /** Every assessment's summary columns, newest first. */
  summaries(): Promise<AssessmentSummaryRow[]> {
    return queryAll<AssessmentSummaryRow>({
      TableName: TABLES.assessments,
      IndexName: INDEX.assessmentsByDate,
      KeyConditionExpression: 'list_pk = :all',
      ExpressionAttributeValues: { ':all': ALL_ASSESSMENTS },
      ScanIndexForward: false,
    });
  },
  /** Saves the assessment and its child's row (new, or with corrected details) in one transaction. */
  async create(input: NewAssessment, child: { row: ChildRow; isNew: boolean }): Promise<AssessmentRow> {
    const reference = await nextReference(new Date(input.assessedAt));
    const ts = nowIso();
    const row: AssessmentRow = {
      id: newId(),
      reference,
      child_id: input.childId,
      assessed_at: input.assessedAt,
      age_months: input.ageMonths,
      band: input.band,
      band_overridden: bit(input.bandOverridden),
      checklist_version: input.checklistVersion,
      child_snapshot_json: JSON.stringify(input.child),
      responses_json: JSON.stringify(input.responses),
      goals_json: input.goals ? JSON.stringify(input.goals) : null,
      interests_json: JSON.stringify(input.interests),
      stats_json: JSON.stringify(input.stats),
      overall_pct: input.overallPct,
      auto_target_pct: input.autoTargetPct,
      target_pct: input.targetPct,
      target_is_custom: bit(input.targetIsCustom),
      focus_json: JSON.stringify(input.focusAreas),
      commentary_json: JSON.stringify(input.commentary),
      previous_json: input.previous ? JSON.stringify(input.previous) : null,
      notes: input.notes,
      assessor_id: input.assessorId,
      assessor_name: input.assessorName,
      report_version: 0,
      report_generated_at: null,
      report_error: null,
      share_nonce: input.shareNonce,
      share_expires_at: input.shareExpiresAt,
      sync_status: input.syncStatus,
      sync_attempts: 0,
      sync_error: null,
      synced_at: null,
      created_at: ts,
      updated_at: ts,
    };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLES.children,
                Item: child.row,
                ConditionExpression: child.isNew ? 'attribute_not_exists(id)' : 'attribute_exists(id)',
              },
            },
            { Put: { TableName: TABLES.assessments, Item: { ...row, list_pk: ALL_ASSESSMENTS } } },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new ConflictError('That child record no longer exists. Start a new assessment.');
      throw error;
    }
    return row;
  },
  async list(options: { q: string; limit: number; offset: number }): Promise<{ items: AssessmentListItemDTO[]; total: number }> {
    const [summaries, childRows] = await Promise.all([
      assessments.summaries(),
      scanAll<ChildRow>({ TableName: TABLES.children, ConsistentRead: true }),
    ]);
    const childById = new Map(childRows.map((row) => [row.id, row]));
    const joined = summaries.flatMap((summary) => {
      const child = childById.get(summary.child_id);
      return child ? [{ summary, child }] : [];
    });
    const matches = childMatcher(options.q);
    const term = options.q.trim().toLowerCase();
    const listed = matches ? joined.filter(({ summary, child }) => matches(child) || summary.reference.toLowerCase().includes(term)) : joined;
    const page = listed.slice(options.offset, options.offset + options.limit);
    const latestDeliveries = await Promise.all(page.map(({ summary }) => deliveries.latestForAssessment(summary.id)));
    return {
      total: listed.length,
      items: page.map(({ summary, child }, i) => {
        const delivery = latestDeliveries[i];
        return {
          id: summary.id,
          reference: summary.reference,
          assessedAt: summary.assessed_at,
          ageMonths: summary.age_months,
          band: summary.band,
          overallPct: summary.overall_pct,
          targetPct: summary.target_pct,
          assessorName: summary.assessor_name,
          reportReady: summary.report_version > 0,
          child: {
            id: child.id,
            firstName: child.first_name,
            lastName: child.last_name,
            centre: child.centre,
            parentName: child.parent_name,
            parentPhone: child.parent_phone,
          },
          lastDelivery: delivery
            ? { channel: delivery.channel, mode: delivery.mode, status: delivery.status, createdAt: delivery.created_at }
            : null,
        };
      }),
    };
  },
  /** Corrected child/parent details, with the results that depend on the child's age. */
  async updateDetails(
    id: string,
    input: { child: ChildDTO; ageMonths: number; bandOverridden: boolean; autoTargetPct: number; targetPct: number; focusAreas: FocusAreaDetail[] },
  ): Promise<void> {
    await setFields(TABLES.assessments, { id }, {
      child_snapshot_json: JSON.stringify(input.child),
      age_months: input.ageMonths,
      band_overridden: bit(input.bandOverridden),
      auto_target_pct: input.autoTargetPct,
      target_pct: input.targetPct,
      focus_json: JSON.stringify(input.focusAreas),
      updated_at: nowIso(),
    });
  },
  async recordReport(id: string, version: number): Promise<void> {
    const ts = nowIso();
    await setFields(TABLES.assessments, { id }, { report_version: version, report_generated_at: ts, report_error: null, updated_at: ts });
  },
  async recordReportError(id: string, error: string): Promise<void> {
    await setFields(TABLES.assessments, { id }, { report_error: error, updated_at: nowIso() });
  },
  async rotateShare(id: string, nonce: string, expiresAt: string): Promise<void> {
    await setFields(TABLES.assessments, { id }, { share_nonce: nonce, share_expires_at: expiresAt, updated_at: nowIso() });
  },
  async recordSync(id: string, sync: { status: SyncStatus; attempts: number; error: string | null; syncedAt: string | null }): Promise<void> {
    await setFields(TABLES.assessments, { id }, {
      sync_status: sync.status,
      sync_attempts: sync.attempts,
      sync_error: sync.error,
      synced_at: sync.syncedAt,
      updated_at: nowIso(),
    });
  },
  async unsynced(maxAttempts: number): Promise<AssessmentRow[]> {
    const rows = await scanAll<AssessmentRow>({
      TableName: TABLES.assessments,
      FilterExpression: 'sync_status IN (:pending, :failed) AND sync_attempts < :max',
      ExpressionAttributeValues: { ':pending': 'pending', ':failed': 'failed', ':max': maxAttempts },
    });
    return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  },
  /** Deletes the assessment and its delivery log. */
  async delete(id: string): Promise<void> {
    await deliveries.deleteForAssessment(id);
    await ddb.send(new DeleteCommand({ TableName: TABLES.assessments, Key: { id } }));
  },
};

/* ------------------------------------------------------------ checklist */

export interface ChecklistItemRow {
  id: string;
  band: BandKey;
  domain: DomainKey;
  text: string;
  removed_at: string | null;
}

interface StoredChecklistItem extends ChecklistItemRow {
  item_key: string;
  number: number;
  position: number;
  created_by?: string | null;
  created_at: string;
  removed_by?: string | null;
}

const CHECKLIST_REVISION = 'checklist-revision';
const CHECKLIST_ITEM_ID = /^(0-2|2-4|4-6):(physical|sensory|language|social):([1-9]\d{0,3})$/;

function checklistItemAddress(id: string): { band: BandKey; item_key: string } | null {
  const match = CHECKLIST_ITEM_ID.exec(id);
  return match ? { band: match[1] as BandKey, item_key: checklistItemKey(match[2] as DomainKey, Number(match[3])) } : null;
}

/** A band's questions, or one area's, in checklist order, including removed ones. */
function storedItems(band: BandKey, domain?: DomainKey): Promise<StoredChecklistItem[]> {
  return queryAll<StoredChecklistItem>({
    TableName: TABLES.checklist,
    KeyConditionExpression: domain ? '#band = :band AND begins_with(item_key, :domain)' : '#band = :band',
    ExpressionAttributeNames: { '#band': 'band' },
    ExpressionAttributeValues: domain ? { ':band': band, ':domain': `${domain}#` } : { ':band': band },
    ConsistentRead: true,
  });
}

const inUse = (item: StoredChecklistItem) => !item.removed_at;

export const checklist = {
  /** Every question in use, per band and domain, in checklist order. */
  async current(): Promise<Checklist> {
    const result: Checklist = { '0-2': emptyBandItems(), '2-4': emptyBandItems(), '4-6': emptyBandItems() };
    const bands = await Promise.all(BANDS.map((band) => storedItems(band)));
    for (const items of bands) {
      for (const item of items.filter(inUse)) result[item.band][item.domain].push({ id: item.id, text: item.text });
    }
    return result;
  },
  async forBand(band: BandKey): Promise<BandItems> {
    const result = emptyBandItems();
    for (const item of (await storedItems(band)).filter(inUse)) result[item.domain].push({ id: item.id, text: item.text });
    return result;
  },
  /** The base version, plus ".rN" once administrators have changed the questions N times. */
  async version(): Promise<string> {
    const revision = await readCounter(CHECKLIST_REVISION);
    return revision ? `${CHECKLIST_VERSION}.r${revision}` : CHECKLIST_VERSION;
  },
  async byId(id: string): Promise<ChecklistItemRow | undefined> {
    const address = checklistItemAddress(id);
    const item = address ? await getItem<StoredChecklistItem>(TABLES.checklist, address) : undefined;
    return item ? { id: item.id, band: item.band, domain: item.domain, text: item.text, removed_at: item.removed_at ?? null } : undefined;
  },
  async activeCount(band: BandKey, domain: DomainKey): Promise<number> {
    return (await storedItems(band, domain)).filter(inUse).length;
  },
  async hasText(band: BandKey, domain: DomainKey, text: string): Promise<boolean> {
    const wanted = text.toLowerCase();
    return (await storedItems(band, domain)).some((item) => inUse(item) && item.text.toLowerCase() === wanted);
  },
  /** Adds a question at the end of its list. Its number is never reused, even after it is removed. */
  async add(input: { band: BandKey; domain: DomainKey; text: string; userId: string }): Promise<ChecklistItem> {
    const number = (await storedItems(input.band, input.domain)).reduce((max, item) => Math.max(max, item.number), 0) + 1;
    const item: StoredChecklistItem = {
      band: input.band,
      item_key: checklistItemKey(input.domain, number),
      id: itemId(input.band, input.domain, number - 1),
      domain: input.domain,
      number,
      position: number,
      text: input.text,
      created_by: input.userId,
      created_at: nowIso(),
      removed_by: null,
      removed_at: null,
    };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: TABLES.checklist, Item: item, ConditionExpression: 'attribute_not_exists(item_key)' } },
            counterIncrement(CHECKLIST_REVISION),
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new ConflictError('Someone added a question to this list at the same moment. Please try again.');
      throw error;
    }
    return { id: item.id, text: item.text };
  },
  /** Takes a question out of new assessments; saved assessments keep their copy of it. */
  async remove(id: string, userId: string): Promise<void> {
    const address = checklistItemAddress(id);
    if (!address) return;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLES.checklist,
                Key: address,
                UpdateExpression: 'SET removed_at = :ts, removed_by = :user',
                ConditionExpression: 'attribute_exists(item_key) AND (attribute_not_exists(removed_at) OR removed_at = :none)',
                ExpressionAttributeValues: { ':ts': nowIso(), ':user': userId, ':none': null },
              },
            },
            counterIncrement(CHECKLIST_REVISION),
          ],
        }),
      );
    } catch (error) {
      // Already removed by someone else: nothing left to do.
      if (!isConditionFailure(error)) throw error;
    }
  },
};

/* ----------------------------------------------------------- deliveries */

export interface DeliveryRow {
  id: string;
  assessment_id: string;
  channel: DeliveryChannel;
  mode: DeliveryMode;
  recipient: string;
  status: DeliveryStatus;
  report_version: number;
  provider_message_id: string | null;
  error: string | null;
  /** Storage key of the saved .eml (preview mode only). */
  preview_path: string | null;
  sent_by: string;
  created_at: string;
  sent_by_name: string;
}

type StoredDelivery = Omit<DeliveryRow, 'sent_by_name'>;

export function toDeliveryDTO(row: DeliveryRow): DeliveryDTO {
  return {
    id: row.id,
    channel: row.channel,
    mode: row.mode,
    recipient: row.recipient,
    status: row.status,
    reportVersion: row.report_version,
    providerMessageId: row.provider_message_id,
    error: row.error,
    sentBy: row.sent_by_name,
    createdAt: row.created_at,
    previewUrl: row.preview_path ? `${config.basePath}/api/deliveries/${row.id}/preview.eml` : null,
  };
}

/** Adds the sender's current name, as the SQL join with users did. */
async function withSenderNames(rows: StoredDelivery[]): Promise<DeliveryRow[]> {
  const senderIds = [...new Set(rows.map((row) => row.sent_by))];
  const names = new Map(await Promise.all(senderIds.map(async (id) => [id, (await users.byId(id))?.name ?? ''] as const)));
  return rows.map((row) => ({ ...row, sent_by_name: names.get(row.sent_by) ?? '' }));
}

function deliveriesQuery(assessmentId: string) {
  return {
    TableName: TABLES.deliveries,
    IndexName: INDEX.deliveriesByAssessment,
    KeyConditionExpression: 'assessment_id = :assessment',
    ExpressionAttributeValues: { ':assessment': assessmentId },
    ScanIndexForward: false,
  };
}

export const deliveries = {
  async byId(id: string): Promise<DeliveryRow | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await getItem<StoredDelivery>(TABLES.deliveries, { id });
    return row ? (await withSenderNames([row]))[0] : undefined;
  },
  async forAssessment(assessmentId: string): Promise<DeliveryRow[]> {
    return withSenderNames(await queryAll<StoredDelivery>(deliveriesQuery(assessmentId)));
  },
  async latestForAssessment(assessmentId: string): Promise<StoredDelivery | undefined> {
    const result = await ddb.send(new QueryCommand({ ...deliveriesQuery(assessmentId), Limit: 1 }));
    return result.Items?.[0] as StoredDelivery | undefined;
  },
  async create(input: {
    id?: string;
    assessmentId: string;
    channel: DeliveryChannel;
    mode: DeliveryMode;
    recipient: string;
    status: DeliveryStatus;
    reportVersion: number;
    providerMessageId: string | null;
    error: string | null;
    previewPath: string | null;
    sentBy: string;
  }): Promise<DeliveryRow> {
    const row: StoredDelivery = {
      id: input.id ?? newId(),
      assessment_id: input.assessmentId,
      channel: input.channel,
      mode: input.mode,
      recipient: input.recipient,
      status: input.status,
      report_version: input.reportVersion,
      provider_message_id: input.providerMessageId,
      error: input.error,
      preview_path: input.previewPath,
      sent_by: input.sentBy,
      created_at: nowIso(),
    };
    await ddb.send(new PutCommand({ TableName: TABLES.deliveries, Item: row }));
    return (await withSenderNames([row]))[0]!;
  },
  async deleteForAssessment(assessmentId: string): Promise<void> {
    const rows = await queryAll<StoredDelivery>(deliveriesQuery(assessmentId));
    await batchWrite(TABLES.deliveries, rows.map((row) => ({ delete: { id: row.id } })));
  },
};
