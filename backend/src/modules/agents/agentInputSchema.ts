import { z, type ZodType } from "zod";

import { agentSurfacePositions, type AgentInput } from "./domain.js";

export const agentInputThemeSchema = z.object({
  brand: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  brandText: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  surface: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  text: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const agentInputLlmProviderNames = ["openai", "openai-compatible", "gemini", "claude"] as const;

const agentInputChatModelOverrideSchema = z.union([
  z.null(),
  z.object({
    provider: z.enum(agentInputLlmProviderNames),
    model: z.string().min(1).max(200),
  }),
]);

export const agentInputFieldSchemas = {
  name: z.string().max(200),
  internalName: z.string().max(200),
  customInstruction: z.string().max(2000),
  suggestedQuestionsEnabled: z.boolean(),
  assistantLinkUtmEnabled: z.boolean(),
  citationDisplayEnabled: z.boolean(),
  contactRequestsEnabled: z.boolean(),
  webhookExportsEnabled: z.boolean(),
  handoffOnRetrievalMiss: z.boolean(),
  contactRequestDelivery: z.object({
    recipientEmails: z.array(z.string().max(320)).max(5).optional(),
    webhook: z.union([
      z.null(),
      z.object({
        url: z.string().max(2048),
      }),
    ]).optional(),
  }),
  retrievalEnabled: z.boolean(),
  logo: z.union([
    z.null(),
    z.object({
      bucket: z.string(),
      objectPath: z.string(),
      generation: z.string().nullable().optional(),
      mimeType: z.string(),
      filename: z.string(),
      sizeBytes: z.number(),
    }),
  ]),
  theme: agentInputThemeSchema,
  branding: z.object({
    hidePoweredBy: z.boolean().optional(),
    privacyPolicyUrl: z.string().max(2048).nullable().optional(),
  }),
  publicDescription: z.string().max(500),
  agentCardEnabled: z.boolean(),
  publicAgentAccessEnabled: z.boolean(),
  walkInConversationsPerHour: z.number().int().min(1).max(100_000).nullable(),
  greetingInstruction: z.string().max(200),
  assistantDefaultLocale: z.string().max(35).nullable(),
  proactiveGreetingEnabled: z.boolean(),
  sourceScope: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("all"),
    }),
    z.object({
      mode: z.literal("selected"),
      sourceIds: z.array(z.string().uuid()).max(200),
    }),
  ]),
  skillSettings: z.record(z.unknown()),
  chatModelOverride: agentInputChatModelOverrideSchema,
  surfaceSettings: z.object({
    authenticatedChat: z.object({
      enabled: z.boolean().optional(),
    }).optional(),
    anonymousChat: z.object({
      enabled: z.boolean().optional(),
    }).optional(),
    websiteEmbed: z.object({
      enabled: z.boolean().optional(),
      allowedOrigins: z.array(z.string().max(200)).max(20).optional(),
      launcherLabel: z.string().max(80).optional(),
      launcherPosition: z.enum(agentSurfacePositions).optional(),
      theme: agentInputThemeSchema.optional(),
      copy: z.record(z.record(z.string().max(500))).optional(),
      expertOverrides: z.record(z.string().max(500)).optional(),
    }).optional(),
    extensions: z.record(z.unknown()).optional(),
  }),
  /**
   * `publicId` is deliberately absent. This map is the allowed-field list for both the PUT body
   * (`agentBodySchema`) and Ray's `propose_agent_setting`, and a public id is minted and rotated
   * by the agent service, never authored — an entry here would let a caller pick its own
   * discovery key or quietly re-point one that is already in the wild.
   */
} satisfies Record<Exclude<keyof AgentInput, "publicId">, ZodType>;

/** The reviewed-operation surface deliberately excludes channel, retrieval, model, asset, and
 * skill settings because those owners have dedicated authoring flows. */
export const agentReviewedSettingsPatchSchema = z.object({
  name: agentInputFieldSchemas.name,
  internalName: agentInputFieldSchemas.internalName,
  customInstruction: agentInputFieldSchemas.customInstruction,
  greetingInstruction: agentInputFieldSchemas.greetingInstruction,
  assistantDefaultLocale: agentInputFieldSchemas.assistantDefaultLocale,
  proactiveGreetingEnabled: agentInputFieldSchemas.proactiveGreetingEnabled,
  citationDisplayEnabled: agentInputFieldSchemas.citationDisplayEnabled,
  assistantLinkUtmEnabled: agentInputFieldSchemas.assistantLinkUtmEnabled,
  handoffOnRetrievalMiss: agentInputFieldSchemas.handoffOnRetrievalMiss,
  contactRequestsEnabled: agentInputFieldSchemas.contactRequestsEnabled,
  contactRequestDelivery: agentInputFieldSchemas.contactRequestDelivery,
  webhookExportsEnabled: agentInputFieldSchemas.webhookExportsEnabled,
  publicDescription: agentInputFieldSchemas.publicDescription,
  theme: agentInputFieldSchemas.theme,
  branding: agentInputFieldSchemas.branding,
  walkInConversationsPerHour: agentInputFieldSchemas.walkInConversationsPerHour,
  agentCardEnabled: agentInputFieldSchemas.agentCardEnabled,
  publicAgentAccessEnabled: agentInputFieldSchemas.publicAgentAccessEnabled,
}).partial().strict().refine((patch) => Object.keys(patch).length > 0, {
  message: "At least one reviewable agent setting must be provided",
});

export type AgentReviewedSettingsKey = keyof z.infer<typeof agentReviewedSettingsPatchSchema>;
export type AgentReviewedSettingsPatch = z.infer<typeof agentReviewedSettingsPatchSchema>;

/**
 * Dot-paths, from the `agent_configuration` detail output's `agent` object, of authored fields
 * whose write bound above exceeds the operator MCP's generic string-compaction limit (500
 * characters — `MAX_STRING_CHARS` in `operatorCopilot/payloadCompaction.ts`). `prepare_agent_settings`
 * and `propose_agent_setting` replace each of these fields whole (one key, one new value — see
 * `proposalSettingPatch` in `services/agentService.ts`), so an operator whose read tool silently cut
 * one of them could not safely resubmit it without also dropping the part they never saw. That gap
 * is issue #1352, raised against `customInstruction`.
 *
 * Every other authored field is left out on purpose:
 * - `name`, `internalName`, `greetingInstruction` (200), `assistantDefaultLocale` (35), and
 *   `publicDescription` (500) already fit within 500 characters on write, so compaction never cuts
 *   them.
 * - `logo.filename`/`logo.mimeType`, `surfaceSettings.extensions`, and `skillSettings` tuning values
 *   (e.g. `semanticRewriteInstructions`) carry no write-time bound at all — there is no worst case to
 *   exempt against, so they stay generically compacted like any other unbounded string.
 * - `contactRequestDelivery` and the website-embed token/origins are redacted to placeholders before
 *   `agent_configuration` ever sees them, so their real values (and write bounds) never reach this
 *   output in the first place.
 */
export const AGENT_CONFIG_FULL_TEXT_FIELD_PATHS: readonly string[] = [
  "customInstruction", // agentInputFieldSchemas.customInstruction, max 2,000
  "branding.privacyPolicyUrl", // agentInputFieldSchemas.branding (privacyPolicyUrl), max 2,048
];

export const agentSettingProposalEffect = (key: AgentReviewedSettingsKey): {
  readonly lifecycle: "live" | "agent_draft";
  readonly reach: boolean;
} => ({
  lifecycle: key === "customInstruction" ? "agent_draft" : "live",
  reach: key === "agentCardEnabled" || key === "publicAgentAccessEnabled",
});
