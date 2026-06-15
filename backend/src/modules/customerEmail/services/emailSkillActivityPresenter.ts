import type {
  CustomerEmailSkillMode,
  CustomerEmailSkillOutcome,
  EmailSkillActivitySummary,
  EmailSkillRecipientSummary,
} from "../domain.js";
import type {
  CreateEmailSkillActivityInput,
  EmailSkillActivityRecord,
} from "../../../db/repositories/emailSkillActivityRepository.js";
import type { CustomerEmailMessageInput } from "../providers/customerEmailProvider.js";

const maxRecipientHints = 5;
const emailLikePattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;

export interface EmailSkillActivityBuildInput {
  workspaceId: string;
  agentId: string;
  routineId?: string | null;
  conversationId?: string | null;
  skillDefinitionId: string;
  connectionId: string;
  skillName: string;
  mode: CustomerEmailSkillMode;
  outcome: CustomerEmailSkillOutcome;
  message?: Partial<CustomerEmailMessageInput> | null;
  providerMessageId?: string | null;
  errorCode?: string | null;
}

const splitRecipients = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(splitRecipients);
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const normalizeEmail = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase();
  const address = trimmed.includes("<") && trimmed.includes(">")
    ? trimmed.slice(trimmed.indexOf("<") + 1, trimmed.lastIndexOf(">")).trim()
    : trimmed;
  return emailLikePattern.test(address) ? address : null;
};

const domainFor = (email: string): string | null => {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  return domain || null;
};

const redactEmail = (email: string): string => {
  const [local, domain] = email.split("@");
  const first = local?.slice(0, 1) || "*";
  return `${first}***@${domain ?? "redacted"}`;
};

export const summarizeEmailRecipients = (message: Partial<CustomerEmailMessageInput> | null | undefined): EmailSkillRecipientSummary => {
  const to = splitRecipients(message?.to).map(normalizeEmail).filter((item): item is string => item !== null);
  const cc = splitRecipients(message?.cc).map(normalizeEmail).filter((item): item is string => item !== null);
  const all = [...to, ...cc];
  const domains = [...new Set(all.map(domainFor).filter((item): item is string => item !== null))].sort();
  return {
    toCount: to.length,
    ccCount: cc.length,
    domains,
    redactedRecipients: all.slice(0, maxRecipientHints).map(redactEmail),
  };
};

const sanitizeOptionalCode = (value: string | null | undefined): string | null => {
  if (!value) return null;
  return value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 120);
};

export const buildEmailSkillActivityRecordInput = (
  input: EmailSkillActivityBuildInput,
): CreateEmailSkillActivityInput => ({
  workspaceId: input.workspaceId,
  agentId: input.agentId,
  routineId: input.routineId ?? null,
  conversationId: input.conversationId ?? null,
  skillDefinitionId: input.skillDefinitionId,
  connectionId: input.connectionId,
  skillName: input.skillName,
  mode: input.mode,
  outcome: input.outcome,
  recipientSummary: summarizeEmailRecipients(input.message),
  providerMessageId: sanitizeOptionalCode(input.providerMessageId),
  errorCode: sanitizeOptionalCode(input.errorCode),
});

export const presentEmailSkillActivity = (record: EmailSkillActivityRecord): EmailSkillActivitySummary => ({
  id: record.id,
  workspaceId: record.workspaceId,
  agentId: record.agentId,
  routineId: record.routineId,
  conversationId: record.conversationId,
  skillDefinitionId: record.skillDefinitionId,
  connectionId: record.connectionId,
  skillName: record.skillName,
  mode: record.mode,
  outcome: record.outcome,
  recipientSummary: record.recipientSummary,
  providerMessageId: record.providerMessageId,
  errorCode: record.errorCode,
  createdAt: record.createdAt.toISOString(),
});

export const buildEmailSkillActivityAuditPayload = (record: EmailSkillActivityRecord): EmailSkillActivitySummary =>
  presentEmailSkillActivity(record);
