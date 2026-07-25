import { z } from "zod";

import { metadataFilterSchema } from "./metadataFilterSchema.js";
import { chatMessageSchema } from "./textInputLimits.js";

const localeHintSchema = z.string().trim().max(35);

const userInputMetadataSchema = z.object({
  method: z.enum(["typed", "suggestion_click", "intent_click"]),
  suggestionSourceMessageId: z.string().uuid().optional(),
  intent: z.object({
    skillName: z.string().trim().min(1).max(120),
    intentName: z.string().trim().min(1).max(120).optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.method === "suggestion_click" && !value.suggestionSourceMessageId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "suggestionSourceMessageId is required for suggestion_click",
      path: ["suggestionSourceMessageId"],
    });
  }
  if (value.method === "intent_click" && !value.intent) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "intent is required for intent_click",
      path: ["intent"],
    });
  }
});

const sourceContextSchema = z.object({
  surface: z.enum(["authenticated_chat", "public_chat", "website_embed"]).optional(),
  sourceOrigin: z.string().trim().max(200).nullable().optional(),
}).optional();

export const assistantChatSchema = z.object({
  agentId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  bootstrapGreetingId: z.string().uuid().optional(),
  message: chatMessageSchema.optional(),
  startConversation: z.boolean().optional().default(false),
  stream: z.boolean().default(false),
  includeDebug: z.boolean().optional().default(false),
  userExpectedLocale: localeHintSchema.optional(),
  inputMetadata: userInputMetadataSchema.optional(),
  sourceContext: sourceContextSchema,
  metadataFilter: metadataFilterSchema,
  // Operator-only workbench test override: routine definition ids (including
  // unpublished drafts) to make eligible for this conversation so an author can
  // test-run a draft end-to-end. Only reachable on this workspace-session route;
  // the public chat surface has no such field, so an end-user turn can never
  // activate a draft. Ephemeral — never persisted to the routine catalog.
  previewRoutineIds: z.array(z.string().uuid()).max(20).optional(),
}).superRefine((value, ctx) => {
  if (!value.message && !value.startConversation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message is required unless startConversation is true",
      path: ["message"],
    });
  }
  if (value.startConversation && value.conversationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startConversation may only be used for brand-new conversations",
      path: ["conversationId"],
    });
  }
  if (value.startConversation && value.bootstrapGreetingId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bootstrapGreetingId may only be used with a persisted user turn",
      path: ["bootstrapGreetingId"],
    });
  }
  if (value.conversationId && value.bootstrapGreetingId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bootstrapGreetingId may only be used for the first persisted user turn",
      path: ["bootstrapGreetingId"],
    });
  }
});
