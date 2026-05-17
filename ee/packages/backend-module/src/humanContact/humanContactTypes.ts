import { randomBytes } from "node:crypto";

import type {
  ActivitySummary,
  ActivityTrace,
  ChatGateway,
  ContactHistoryDetail,
  ContactHistorySummary,
  MailTransport,
  UsageLimitDatabaseClient,
  UsageLimitDatabasePort,
} from "../radiosoModuleTypes.js";
import type { SkillSubmissionRow } from "../skillSubmissions/skillSubmissionRepository.js";

export type Logger = {
  info?(entry: unknown, message?: string): void;
  warn?(entry: unknown, message?: string): void;
  error(entry: unknown, message?: string): void;
};

export type MailService = MailTransport;

export interface WorkspaceContactInfo {
  id: string;
  name: string;
  publicRouteKey: string;
}

export interface WorkspaceContactInfoRepository {
  findById(workspaceId: string): Promise<WorkspaceContactInfo | null>;
}

export interface ConversationRepository {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{
    id: string;
    workspaceId: string;
    sourceChannel: string | null;
    sourceOrigin: string | null;
    anonymousSessionId: string | null;
  } | null>;
  findByIdAndAnonymousSession(conversationId: string, workspaceId: string, anonymousSessionId: string): Promise<{
    id: string;
    workspaceId: string;
    sourceChannel: string | null;
    sourceOrigin: string | null;
    anonymousSessionId: string | null;
  } | null>;
}

export interface MessageRepository {
  listRecentByConversationId(workspaceId: string, conversationId: string, limit: number): Promise<Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: Date;
  }>>;
}

export interface AuditService {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface AbuseControlService {
  enforce(input: {
    scope: string;
    subjectKey: string;
    limit: number;
    windowMs: number;
    blockMs?: number;
  }): Promise<void>;
}

export interface HumanContactSettingsRow {
  workspace_id: string;
  enabled: boolean;
  email_enabled: boolean;
  default_email: string | null;
  webhook_enabled: boolean;
  webhook_url: string | null;
  signing_secret: string | null;
  updated_at: Date;
}

export interface SkillIntakeStateRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  skill_name: string;
  status: "active" | "paused" | "awaiting_confirmation" | "awaiting_tool" | "completed" | "cancelled" | "expired" | "failed";
  collected: Record<string, unknown>;
  invalid: Record<string, unknown>;
  missing: string[];
  expires_at: Date | string | null;
  last_prompted_field: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export const MAX_ATTEMPTS = 8;
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const PUBLIC_CONTACT_LIMIT = 3;
export const AUTHENTICATED_CONTACT_LIMIT = 10;
export const CONTACT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const HUMAN_CONTACT_SKILL_NAME = "human_contact.request";
export const HUMAN_CONTACT_INTAKE_TTL_MS = 15 * 60 * 1000;

export const queryRows = async <T = Record<string, unknown>>(
  client: UsageLimitDatabaseClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const result = await client.query<T>(text, params);
  return Array.isArray(result) ? result : result.rows;
};

export const normalizeOptionalText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export const normalizeIdempotencyKey = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
};

export const contactIntakeIdempotencyKey = (id: string): string => `human-contact:intake:${id}`;

export const generateSecret = (): string => randomBytes(32).toString("base64url");

export const serializeDate = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const normalizePreview = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 180);

export const summarizeContactTrace = (trace: ActivityTrace | null | undefined): ActivitySummary | undefined =>
  trace?.summary ?? undefined;

const contactEmailFromSubmission = (row: SkillSubmissionRow): string =>
  typeof row.fields.email === "string" ? row.fields.email : (row.subject_identity ?? "");

const contactMessageFromSubmission = (row: SkillSubmissionRow): string =>
  typeof row.fields.message === "string" ? row.fields.message : "";

export const mapContactHistorySummary = (row: SkillSubmissionRow): ContactHistorySummary => ({
  id: row.id,
  sortAt: serializeDate(row.created_at),
  workspaceId: row.workspace_id,
  conversationId: row.conversation_id,
  assistantMessageId: row.assistant_message_id,
  sourceChannel: row.source_channel,
  sourceOrigin: row.source_origin,
  userEmail: contactEmailFromSubmission(row),
  messagePreview: normalizePreview(contactMessageFromSubmission(row)),
  triggerSource: row.trigger_source,
  triggerReason: row.trigger_reason,
  status: row.status,
  attempts: row.attempts,
  createdAt: serializeDate(row.created_at),
  updatedAt: serializeDate(row.updated_at),
  activitySummary: summarizeContactTrace(row.activity_trace),
});

export const mapContactHistoryDetail = (row: SkillSubmissionRow): ContactHistoryDetail => ({
  ...mapContactHistorySummary(row),
  message: contactMessageFromSubmission(row),
  finalDeliveryError: row.final_delivery_error,
  activityTrace: row.activity_trace ?? undefined,
});

export const mapSettings = (row: HumanContactSettingsRow | undefined | null) => {
  const webhookUrl = row?.webhook_url ?? null;
  const signingSecretConfigured = Boolean(row?.signing_secret);
  const emailEnabled = Boolean(row?.email_enabled);
  const defaultEmail = row?.default_email ?? null;
  const webhookEnabled = Boolean(row?.webhook_enabled);
  const enabled = Boolean(row?.enabled);
  const emailConfigured = emailEnabled && Boolean(defaultEmail);
  const webhookConfigured = webhookEnabled && Boolean(webhookUrl) && signingSecretConfigured;
  return {
    enabled,
    configured: enabled && (emailConfigured || webhookConfigured),
    emailEnabled,
    defaultEmail,
    webhookEnabled,
    webhookUrl,
    signingSecretConfigured,
    updatedAt: row?.updated_at ? serializeDate(row.updated_at) : null,
  };
};

export type HumanContactDependencies = {
  database: UsageLimitDatabasePort;
  logger: Logger;
  conversationRepository: ConversationRepository;
  messageRepository: MessageRepository;
  workspaceContactInfoRepository?: WorkspaceContactInfoRepository;
  auditService: AuditService;
  abuseControlService: AbuseControlService;
  mailService: MailService;
  chatGateway: ChatGateway;
  dashboardBaseUrl?: string | null;
  pollIntervalMs?: number;
  webhookFetch?: typeof fetch;
  startPoller?: boolean;
};
