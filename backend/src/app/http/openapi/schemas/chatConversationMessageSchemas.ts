import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { operatorReplySpeechSchema, replyInterruptionSchema } from "../../../../modules/chat/contracts/index.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";
import { registerUserMessageInputMetadataSchema } from "./userMessageInputMetadataSchemas.js";

/**
 * The conversation message as the operator and public history read it. Registered in
 * the assistant history schemas' order, between the answer-feedback and ownership schemas.
 */
export const registerChatConversationMessageSchemas = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemaCatalog,
  shared: {
    ChatSuggestionSchema: z.ZodTypeAny;
    AnswerFeedbackEntrySchema: z.ZodTypeAny;
    ChatConversationMessageDebugSchema: z.ZodTypeAny;
    ChatConversationTurnFailureSchema: z.ZodTypeAny;
  },
) => {
  const {
    ChatSuggestionSchema,
    AnswerFeedbackEntrySchema,
    ChatConversationMessageDebugSchema,
    ChatConversationTurnFailureSchema,
  } = shared;

  const UserMessageInputMetadataSchema = registerUserMessageInputMetadataSchema(registry);

  const ReplyInterruptionSchema = registry.register(
    "ReplyInterruption",
    replyInterruptionSchema.openapi({
      description: "Present on an assistant reply the caller cut short by speaking over it on the voice channel: how much of the reply they heard. Both counts are in the characters the channel spoke, so they do not index into `content`. `partial: false`: the reply had finished, and `content` keeps all of it. `partial: true`: the caller cut the reply off while it was still being said, so `content` keeps only the sentences they heard whole; `heardCharacterCount` follows the voice runtime's record of what it played, and `spokenCharacterCount` counts what reached the runtime. Without such a record, everything that reached the runtime counts as heard and the two counts are equal.",
    }),
  );

  const OperatorReplySpeechSchema = registry.register(
    "OperatorReplySpeech",
    operatorReplySpeechSchema.openapi({
      description: "Present on a teammate's reply on a voice conversation. A call speaks only when its caller does, so the reply is `pending` until the caller's next turn speaks it, then `spoken`, with `spokenAt` set to when the turn that spoke it ended. When the caller speaks over a turn before it finished, a reply the voice runtime played to its end is `spoken`, and the reply it was playing, with any after it, stays `pending` for the turn that cut in to speak whole. `skipped`: the reply has no words a call can speak, so no turn speaks it.",
    }),
  );

  // Shared by the operator and public message schemas. `debug`, `turnFailure`, and
  // `operatorLabel` are operator-only and are added on top of this shape for the dashboard
  // schema alone: the first two carry turn diagnostics (and `turnFailure` carries raw error
  // text), `operatorLabel` can be a teammate's email, and the public presenter strips all
  // three from every message it returns.
  const chatConversationMessageShape = {
    id: z.string().uuid(),
    role: z.enum(["user", "assistant", "system"]),
    source: z.enum(["customer", "ai_agent", "human_agent", "human_agent_on_behalf_of_ai_agent", "system"]),
    content: z.string(),
    createdAt: z.string().datetime(),
    inputMetadata: UserMessageInputMetadataSchema.optional(),
    citations: z.array(schemas.CitationSchema).optional(),
    answerSegments: z.array(schemas.AnswerSegmentSchema).optional(),
    suggestions: z.array(ChatSuggestionSchema).optional(),
    answerFeedbackEntries: z.array(AnswerFeedbackEntrySchema).optional(),
    operatorDisplayName: z.string().optional(),
    interruption: ReplyInterruptionSchema.optional(),
    speech: OperatorReplySpeechSchema.optional(),
  };

  const ChatConversationMessageSchema = registry.register(
    "ChatConversationMessage",
    z.object({
      ...chatConversationMessageShape,
      debug: ChatConversationMessageDebugSchema.optional(),
      turnFailure: ChatConversationTurnFailureSchema.optional(),
      operatorLabel: z.string().optional().openapi({
        description: "Operator-only. On a human-agent reply, the teammate who wrote it: their display name, else their email, read from their profile now. A reply that names no teammate, or whose teammate is gone, carries its signature instead. Never returned by the public chat API.",
      }),
    }),
  );

  const PublicChatConversationMessageSchema = registry.register(
    "PublicChatConversationMessage",
    z.object(chatConversationMessageShape),
  );

  return { UserMessageInputMetadataSchema, ChatConversationMessageSchema, PublicChatConversationMessageSchema };
};
