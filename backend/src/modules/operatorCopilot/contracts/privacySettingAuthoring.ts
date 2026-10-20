import { z } from "zod";

import { MAX_COPILOT_PROPOSAL_SUMMARY } from "../contracts.js";
import { CONVERSATION_RETENTION_DAYS_RANGE, type PrivacySettings } from "../../privacy/public.js";

const conversationRetentionDays = z.number().int()
  .min(CONVERSATION_RETENTION_DAYS_RANGE.min)
  .max(CONVERSATION_RETENTION_DAYS_RANGE.max)
  .nullable();

/** What Ray names: the fields it wants changed. Null keeps conversations until they are deleted. */
export const copilotPrivacySettingChangeSchema = z.object({
  conversationRetentionDays: conversationRetentionDays.optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();

/** What is stored on the proposal: the complete privacy settings the apply writes. */
export const copilotPrivacySettingPayloadSchema = z.object({
  /** The card's label; the workspace has one privacy settings surface. */
  name: z.literal("Privacy settings"),
  conversationRetentionDays,
  /**
   * Whether applying this lets the retention sweep erase conversations it would not have erased
   * before: a window set where there was none, or shortened. Stated by the payload so a reloaded card
   * reads it without re-deriving it from the values.
   */
  erasesSooner: z.boolean(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  /** The sentence the card states. Stored so a reloaded card reads what the live one did. */
  summary: z.string().min(1).max(MAX_COPILOT_PROPOSAL_SUMMARY).optional(),
}).strict();

/** The stored values the draft was made against; the apply refuses once they changed. */
export const copilotPrivacySettingTargetRefSchema = z.object({
  expectedFields: z.object({ conversationRetentionDays }).strict(),
}).strict();

export type CopilotPrivacySettingPayload = z.infer<typeof copilotPrivacySettingPayloadSchema>;

export interface CopilotPrivacySettingPort {
  prepareFieldProposal(workspaceId: string, patch: Partial<PrivacySettings>): Promise<{
    normalized: PrivacySettings;
    expected: PrivacySettings;
    current: PrivacySettings;
  }>;
  readFieldProposalVersion(workspaceId: string): Promise<string>;
  readFieldProposalDisplay(workspaceId: string): Promise<PrivacySettings>;
  applyFieldProposal(workspaceId: string, prepared: { normalized: PrivacySettings; expected: PrivacySettings }): Promise<
    | { readonly status: "applied" }
    | { readonly status: "changed"; readonly fields: readonly string[] }
    | { readonly status: "target_deleted" }
  >;
}
