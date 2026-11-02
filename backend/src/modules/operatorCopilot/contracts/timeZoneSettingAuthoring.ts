import { z } from "zod";

import { MAX_COPILOT_PROPOSAL_SUMMARY } from "../contracts.js";
import type { TimeZoneSettings } from "../../settings/public.js";
import { TIME_ZONE_MAX_LENGTH } from "../../../shared/domain/referenceTimeZone.js";

const timeZone = z.string().trim().min(1).max(TIME_ZONE_MAX_LENGTH).nullable();

/** What Ray names: the IANA zone the workspace should read "today" in, or null for UTC. */
export const copilotTimeZoneSettingChangeSchema = z.object({
  timeZone: timeZone.optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();

/** What is stored on the proposal: the zone the apply writes, by its canonical name. */
export const copilotTimeZoneSettingPayloadSchema = z.object({
  /** The card's label; the workspace has one time zone. */
  name: z.literal("Time zone"),
  timeZone,
  rationale: z.string().trim().min(1).max(1_000).optional(),
  /** The sentence the card states. Stored so a reloaded card reads what the live one did. */
  summary: z.string().min(1).max(MAX_COPILOT_PROPOSAL_SUMMARY).optional(),
}).strict();

/** The stored zone the draft was made against; the apply refuses once it changed. */
export const copilotTimeZoneSettingTargetRefSchema = z.object({
  expectedFields: z.object({ timeZone }).strict(),
}).strict();

export type CopilotTimeZoneSettingPayload = z.infer<typeof copilotTimeZoneSettingPayloadSchema>;

export interface CopilotTimeZoneSettingPort {
  prepareFieldProposal(workspaceId: string, patch: Partial<TimeZoneSettings>): Promise<{
    normalized: TimeZoneSettings;
    expected: TimeZoneSettings;
    current: TimeZoneSettings;
  }>;
  readFieldProposalVersion(workspaceId: string): Promise<string>;
  readFieldProposalDisplay(workspaceId: string): Promise<TimeZoneSettings>;
  applyFieldProposal(workspaceId: string, prepared: { normalized: TimeZoneSettings; expected: TimeZoneSettings }): Promise<
    | { readonly status: "applied" }
    | { readonly status: "changed"; readonly fields: readonly string[] }
    | { readonly status: "target_deleted" }
  >;
}
