import { z } from "zod";

import { MAX_COPILOT_PROPOSAL_SUMMARY } from "../contracts.js";

import { websiteEmbedLauncherPositions } from "../../settings/public.js";

/**
 * The workspace-settings fields a proposal may carry: the assistant's own wording, and the public
 * channels it answers on. Deliberately absent are the fields whose write is not a settings change
 * at all — the anonymous-chat and embed tokens (rotation is never-list), the assistant logo (Ray
 * can neither produce the bytes nor judge the result), and the embed theme, copy packs, and expert
 * overrides, which are visual design rather than configuration Ray can reason about. Leaving them
 * off the payload means no adapter written against it can touch them.
 */
export const copilotWorkspaceSettingFields = {
  assistantName: z.string().trim().min(1).max(200),
  greetingInstruction: z.string().max(200),
  assistantDefaultLocale: z.string().max(35).nullable(),
  proactiveGreetingEnabled: z.boolean(),
  suggestedQuestionsEnabled: z.boolean(),
  customInstruction: z.string().max(2_000),
  anonymousChatEnabled: z.boolean(),
  websiteEmbedEnabled: z.boolean(),
  websiteEmbedAllowedOrigins: z.array(z.string().max(200)).max(20),
  websiteEmbedLauncherLabel: z.string().max(80),
  websiteEmbedLauncherPosition: z.enum(websiteEmbedLauncherPositions),
} as const;

/**
 * The fields that change *who can reach the agent* rather than what it says. A card proposing one
 * of these is a different kind of decision from a card proposing a greeting, and an operator must
 * not have to infer the difference from the summary's prose — see `changesReach` below.
 */
export const copilotWorkspaceSettingReachFields = [
  "anonymousChatEnabled",
  "websiteEmbedEnabled",
  "websiteEmbedAllowedOrigins",
] as const;

export const copilotWorkspaceSettingChangeSchema = z.object({
  assistantName: copilotWorkspaceSettingFields.assistantName.optional(),
  greetingInstruction: copilotWorkspaceSettingFields.greetingInstruction.optional(),
  assistantDefaultLocale: copilotWorkspaceSettingFields.assistantDefaultLocale.optional(),
  proactiveGreetingEnabled: copilotWorkspaceSettingFields.proactiveGreetingEnabled.optional(),
  suggestedQuestionsEnabled: copilotWorkspaceSettingFields.suggestedQuestionsEnabled.optional(),
  customInstruction: copilotWorkspaceSettingFields.customInstruction.optional(),
  anonymousChatEnabled: copilotWorkspaceSettingFields.anonymousChatEnabled.optional(),
  websiteEmbedEnabled: copilotWorkspaceSettingFields.websiteEmbedEnabled.optional(),
  websiteEmbedAllowedOrigins: copilotWorkspaceSettingFields.websiteEmbedAllowedOrigins.optional(),
  websiteEmbedLauncherLabel: copilotWorkspaceSettingFields.websiteEmbedLauncherLabel.optional(),
  websiteEmbedLauncherPosition: copilotWorkspaceSettingFields.websiteEmbedLauncherPosition.optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict();

/**
 * What is stored on the proposal. The apply replaces the assistant and channel sections together,
 * so the payload holds the complete surface the operator would be applying rather than the fields
 * Ray named — a card showing only the named fields would hide what the rest of the replace carries.
 */
export const copilotWorkspaceSettingPayloadSchema = z.object({
  /** Every proposal card reads its target's label from `name`; this target is the workspace's one
   * settings surface, so the label is a constant rather than something Ray chooses. */
  name: z.literal("Workspace settings"),
  assistantName: copilotWorkspaceSettingFields.assistantName,
  greetingInstruction: copilotWorkspaceSettingFields.greetingInstruction,
  assistantDefaultLocale: copilotWorkspaceSettingFields.assistantDefaultLocale,
  proactiveGreetingEnabled: copilotWorkspaceSettingFields.proactiveGreetingEnabled,
  suggestedQuestionsEnabled: copilotWorkspaceSettingFields.suggestedQuestionsEnabled,
  customInstruction: copilotWorkspaceSettingFields.customInstruction,
  anonymousChatEnabled: copilotWorkspaceSettingFields.anonymousChatEnabled,
  websiteEmbedEnabled: copilotWorkspaceSettingFields.websiteEmbedEnabled,
  websiteEmbedAllowedOrigins: copilotWorkspaceSettingFields.websiteEmbedAllowedOrigins,
  websiteEmbedLauncherLabel: copilotWorkspaceSettingFields.websiteEmbedLauncherLabel,
  websiteEmbedLauncherPosition: copilotWorkspaceSettingFields.websiteEmbedLauncherPosition,
  /**
   * Whether applying this changes who can reach the agent. Stated by the payload, the same way a
   * removal states `removesTarget`, so a reloaded card separates reach from wording without the
   * reader having to recognise which field names mean reach.
   */
  changesReach: z.boolean(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  /** The sentence the card states. Stored so a reloaded card reads what the live one did. */
  summary: z.string().min(1).max(MAX_COPILOT_PROPOSAL_SUMMARY).optional(),
}).strict();

/** Workspace settings are one surface per workspace, and the workspace is already the call's scope. */
export const copilotWorkspaceSettingTargetRefSchema = z.object({}).strict();

export type CopilotWorkspaceSettingChange = z.infer<typeof copilotWorkspaceSettingChangeSchema>;
export type CopilotWorkspaceSettingPayload = z.infer<typeof copilotWorkspaceSettingPayloadSchema>;

/**
 * The settings as the copilot may read them. Narrower than the settings resource the dashboard
 * reads: the anonymous-chat and embed tokens are secret material and are absent from the port, so
 * no adapter written against it can put one in a model context.
 */
export interface CopilotWorkspaceSettingSnapshot {
  readonly assistantName: string;
  readonly greetingInstruction: string;
  readonly assistantDefaultLocale: string | null;
  readonly proactiveGreetingEnabled: boolean;
  readonly suggestedQuestionsEnabled: boolean;
  readonly customInstruction: string;
  readonly anonymousChatEnabled: boolean;
  readonly websiteEmbedEnabled: boolean;
  readonly websiteEmbedAllowedOrigins: ReadonlyArray<string>;
  readonly websiteEmbedLauncherLabel: string;
  readonly websiteEmbedLauncherPosition: string;
  readonly updatedAt: Date;
}

export interface CopilotWorkspaceSettingPort {
  getForWorkspace(workspaceId: string): Promise<CopilotWorkspaceSettingSnapshot>;
  /**
   * `expectedUpdatedAt` carries the version the card was drafted against into the write's own
   * predicate, so a surface edited since the draft is refused rather than replaced wholesale by
   * the values this payload has been holding.
   */
  updateForWorkspace(
    workspaceId: string,
    input: CopilotWorkspaceSettingPayload,
    options?: { expectedUpdatedAt?: Date },
  ): Promise<unknown>;
}
