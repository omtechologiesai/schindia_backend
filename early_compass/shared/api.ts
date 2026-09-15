/** Shapes exchanged between the portal and the API. */
import type { Checklist } from './checklist';
import type { InterestKey } from './data/activities';
import type { GoalAge } from './data/goals';
import type { BandKey, DomainKey } from './domain';
import type { Gender, Relation } from './schemas';
import type { Commentary, DomainStats, FocusAreaDetail } from './scoring';

export type Role = 'admin' | 'staff';

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  role: Role;
  centre: string;
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface ParentContactDTO {
  name: string;
  relation: Relation;
  /** E.164, e.g. "+919876543210" */
  phone: string;
  email: string;
}

export interface ChildDTO {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: Gender | null;
  centre: string;
  parent: ParentContactDTO;
  createdAt: string;
  updatedAt: string;
}

export interface ReadingSummaryDTO {
  id: string;
  reference: string;
  assessedAt: string;
  ageMonths: number;
  band: BandKey;
  stats: DomainStats;
  overallPct: number;
  targetPct: number;
}

export interface ChildListItemDTO extends ChildDTO {
  assessmentCount: number;
  lastAssessment: ReadingSummaryDTO | null;
}

export interface ChildProfileDTO extends ChildDTO {
  assessments: (ReadingSummaryDTO & { assessorName: string; reportReady: boolean })[];
}

export interface ResponseItemDTO {
  id: string;
  domain: DomainKey;
  text: string;
  observed: boolean;
}

export interface GoalResponseDTO {
  id: string;
  category: string;
  text: string;
  achieved: boolean;
}

export type DeliveryChannel = 'email' | 'whatsapp';
export type DeliveryMode = 'ses' | 'smtp' | 'preview' | 'cloud_api' | 'click_to_chat';
export type EmailMode = 'ses' | 'smtp' | 'preview';
/** "prepared" = a click-to-chat message was opened for staff to send; delivery can't be confirmed. */
export type DeliveryStatus = 'sent' | 'failed' | 'prepared';

export interface DeliveryDTO {
  id: string;
  channel: DeliveryChannel;
  mode: DeliveryMode;
  recipient: string;
  status: DeliveryStatus;
  reportVersion: number;
  providerMessageId: string | null;
  error: string | null;
  sentBy: string;
  createdAt: string;
  previewUrl: string | null;
}

export type SyncStatus = 'disabled' | 'pending' | 'synced' | 'failed';

export interface AssessmentListItemDTO {
  id: string;
  reference: string;
  assessedAt: string;
  ageMonths: number;
  band: BandKey;
  overallPct: number;
  targetPct: number;
  assessorName: string;
  child: {
    id: string;
    firstName: string;
    lastName: string;
    centre: string;
    parentName: string;
    parentPhone: string;
  };
  lastDelivery: Pick<DeliveryDTO, 'channel' | 'mode' | 'status' | 'createdAt'> | null;
  reportReady: boolean;
}

export interface AssessmentDTO {
  id: string;
  reference: string;
  assessedAt: string;
  ageMonths: number;
  band: BandKey;
  bandOverridden: boolean;
  checklistVersion: string;
  /** Child and parent details as recorded when the assessment was taken. */
  child: ChildDTO;
  responses: ResponseItemDTO[];
  goals: { age: GoalAge; items: GoalResponseDTO[] } | null;
  interests: InterestKey[];
  stats: DomainStats;
  overallPct: number;
  autoTargetPct: number;
  targetPct: number;
  targetIsCustom: boolean;
  focusAreas: FocusAreaDetail[];
  commentary: Commentary;
  previous: ReadingSummaryDTO | null;
  notes: string;
  assessor: { id: string; name: string };
  report: {
    version: number;
    generatedAt: string | null;
    error: string | null;
    fileName: string;
    pdfUrl: string;
    chartUrl: string;
    snapshotUrl: string;
  };
  share: { url: string; expiresAt: string };
  deliveries: DeliveryDTO[];
  sync: { status: SyncStatus; attempts: number; error: string | null; syncedAt: string | null };
  createdAt: string;
}

export interface ChecklistDTO {
  /** The base checklist version, plus ".rN" once administrators have changed the questions. */
  version: string;
  items: Checklist;
}

export interface MetaDTO {
  orgName: string;
  productName: string;
  timeZone: string;
  email: { mode: EmailMode; from: string };
  whatsapp: { mode: 'cloud_api' | 'click_to_chat'; templateName: string | null };
  publicBaseUrl: string;
  /** False when links point at localhost or a private address a parent's phone can't open. */
  publicLinksReachable: boolean;
  reportLinkDays: number;
  centres: string[];
  sync: { enabled: boolean };
  contact: { email: string; phone: string; website: string };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  error: string;
  fieldErrors?: Record<string, string>;
}

export interface EmailShareResult {
  delivery: DeliveryDTO;
}

export interface WhatsAppShareResult {
  delivery: DeliveryDTO;
  /** For click-to-chat: the wa.me link to open, with the message prefilled. */
  url: string | null;
  message: string;
}
