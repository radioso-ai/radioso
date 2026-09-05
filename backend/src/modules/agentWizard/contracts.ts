import { z } from "zod";

/**
 * The wizard's request and result shapes, defined once. The routes parse against these and the
 * OpenAPI contract publishes them, so the surface a client is told about and the surface the router
 * accepts cannot drift apart.
 */

const agentWizardUrlSchema = z.string().url().max(2048).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "URL must use http or https");

export const agentWizardAnalyzeRequestSchema = z.object({
  url: agentWizardUrlSchema,
});

export const agentWizardCreateRequestSchema = z.object({
  websiteUrl: agentWizardUrlSchema,
  name: z.string().trim().min(1).max(200),
  customInstruction: z.string().max(2000).default(""),
  greetingInstruction: z.string().max(200).default(""),
  chunkingStrategy: z.enum(["fixed_window", "structured_semantic"]).optional(),
  faviconUrl: agentWizardUrlSchema.nullable().optional(),
  assistantDefaultLocale: z.string().max(35).nullable().optional(),
  privacyPolicyUrl: agentWizardUrlSchema.nullable().optional(),
  contactEmail: z.string().max(320).nullable().optional(),
});

const agentWizardChunkingStrategySchema = z.enum(["fixed_window", "structured_semantic"]);

export const agentWizardAnalysisSchema = z.object({
  suggestedName: z.string(),
  suggestedCustomInstruction: z.string(),
  suggestedGreetingMessage: z.string(),
  suggestedChunkingStrategy: z.object({
    strategy: agentWizardChunkingStrategySchema,
    reasoning: z.string(),
  }),
  /** Base64 PNG of the landing page, or null when the browser transport could not capture one. */
  screenshotBase64: z.string().nullable(),
  screenshotUnavailableReason: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  pagesAnalyzed: z.array(z.object({ url: z.string(), title: z.string().nullable() })),
  sourceUrl: z.string(),
  suggestedLocale: z.string().nullable(),
  suggestedPrivacyPolicyUrl: z.string().nullable(),
  suggestedContactEmail: z.string().nullable(),
});

export const agentWizardCreateResultSchema = z.object({
  agentId: z.string().uuid(),
  /** Null when the deployment runs without website crawling, so no ingestion job was queued. */
  crawlJobId: z.string().nullable(),
  /**
   * Present when the agent was created but a step after it failed. The agent exists and is usable;
   * the named step is the one to finish by hand.
   */
  incomplete: z.object({
    step: z.enum(["configuration", "ingestion"]),
    reason: z.string(),
  }).optional(),
});

export const agentWizardProgressEventSchema = z.object({
  type: z.literal("progress"),
  step: z.enum(["crawling", "analyzing", "generating", "complete"]),
  page: z.number().int().optional(),
  total: z.number().int().optional(),
  url: z.string().optional(),
  title: z.string().nullable().optional(),
});

/** What the stream's `error` event carries once headers are already sent. */
export const agentWizardStreamErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
});

