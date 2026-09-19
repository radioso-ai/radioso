import { z } from "zod";

import { chatMessageSchema } from "../schemas/textInputLimits.js";

const localeHintSchema = z.string().trim().max(35);

/** FR-013: entry_referrer is client-claimed, so anything that isn't an http(s) URL is dropped rather than rejected. */
const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export const pageContextSchema = z.object({
  pageUrl: z.string().trim().max(2048).nullable().optional(),
  pageTitle: z.string().trim().max(180).nullable().optional(),
  pageLocale: z.string().trim().max(35).nullable().optional(),
  browserLocale: z.string().trim().max(35).nullable().optional(),
  content: z.string().trim().max(6000).nullable().optional(),
  // Capped by truncation (not `.max()`, which would reject the whole message over an
  // inconsequential metadata field) before the http(s) check, since a truncated string
  // may no longer parse as a URL at all.
  referrer: z.string().trim().nullable().optional()
    .transform((value) => {
      if (!value) return null;
      const capped = value.slice(0, 2048);
      return isHttpUrl(capped) ? capped : null;
    }),
}).optional();

const clientContextCapabilitiesSchema = z.object({
  "page.read": z.object({
    available: z.boolean(),
    mode: z.enum(["metadata", "content"]).nullable(),
    supportedOperations: z.array(z.enum(["metadata", "lookup", "summarize"])).max(3),
  }).optional(),
}).optional();

export const anonymousChatSchema = z.object({
  message: chatMessageSchema.optional(),
  stream: z.boolean().default(false),
  conversationId: z.string().uuid().optional(),
  bootstrapGreetingId: z.string().uuid().optional(),
  startConversation: z.boolean().optional(),
  userExpectedLocale: localeHintSchema.optional(),
  pageContext: pageContextSchema,
  clientContextCapabilities: clientContextCapabilitiesSchema,
  signedIdentity: z.string().max(8192).optional(),
  inputMetadata: z.object({
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
  }).optional(),
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

export const publicConversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const publicChatSessionSchema = z.object({
  channel: z.enum(["anonymous_link", "website_embed"]),
  agentId: z.string().uuid().optional(),
  resumeToken: z.string().min(1).optional(),
  chatSessionId: z.string().uuid().optional(),
  // Spec 1277 decision 6: an unauthenticated, client-persisted visitor-grouping id
  // (never a session credential) — see publicChatRoutes.ts's resolveVisitorKey.
  visitorKey: z.string().uuid().optional(),
  pageContext: pageContextSchema,
  clientContextCapabilities: clientContextCapabilitiesSchema,
});
