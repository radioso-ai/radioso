import { z, type ZodType } from "zod";

import { agentSurfacePositions, type AgentInput } from "./domain.js";

export const agentInputThemeSchema = z.object({
  brand: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  brandText: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  surface: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  text: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const agentInputLlmProviderNames = ["openai", "openai-compatible", "gemini", "claude"] as const;

export const agentInputChatModelOverrideSchema = z.union([
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
} satisfies Record<keyof AgentInput, ZodType>;
