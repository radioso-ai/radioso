import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { routineSlotTypes } from "../../../../modules/routines/public.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

const routineTurnStatuses = ["active", "waiting_for_input", "waiting_for_approval", "completed", "abandoned"] as const;

/**
 * The agent reply envelope: one core schema, referenced by the MCP converse
 * `ask` response and the REST agent chat response so a calling agent reads the
 * same fields on either door. Registered after the chat response schemas
 * because the REST shape intersects `ChatResponse` with the core.
 */
export const registerAgentReplyEnvelopeSchemas = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemaCatalog,
  shared: {
    ChatResponseSchema: z.ZodTypeAny;
    ChatBootstrapResponseSchema: z.ZodTypeAny;
    AnswerCoverageAssessmentSchema: z.ZodTypeAny;
  },
) => {
  const ChatOwnershipAckSchema = registry.register(
    "ChatOwnershipAck",
    z.object({
      state: z.enum(["ai_owned", "human_owned"]),
      suppressed: z.boolean(),
    }).openapi({
      description: "Who owns the conversation after this turn. `suppressed` is true when a human owns it and the agent generated nothing.",
    }),
  );

  const RoutinePendingInputSchema = registry.register(
    "RoutinePendingInput",
    z.object({
      key: z.string(),
      type: z.enum(routineSlotTypes),
      required: z.boolean(),
      description: z.string().optional(),
    }),
  );

  const RoutineTurnStateSchema = registry.register(
    "RoutineTurnState",
    z.object({
      toolName: z.string().optional(),
      name: z.string(),
      status: z.enum(routineTurnStatuses),
      pendingInput: z.array(RoutinePendingInputSchema),
    }).openapi({
      description: "Where the turn left the routine it touched. `pendingInput` lists every unfilled required slot plus the current step's unfilled optional slots, so a caller can supply everything in one re-call.",
    }),
  );

  const AgentReplyEnvelopeCoreSchema = registry.register(
    "AgentReplyEnvelopeCore",
    z.object({
      conversationId: z.string().uuid(),
      answerCoverage: shared.AnswerCoverageAssessmentSchema,
      ownership: ChatOwnershipAckSchema,
      routine: RoutineTurnStateSchema.optional(),
      traceId: z.string().optional(),
    }).openapi({
      description: "The machine-readable part of an agent reply, identical on the MCP converse ask route and the REST agent chat route.",
    }),
  );

  const McpConverseAskResponseSchema = registry.register(
    "McpConverseAskResponse",
    AgentReplyEnvelopeCoreSchema.extend({
      answer: z.object({
        text: z.string(),
        citations: z.array(schemas.CitationSchema),
      }),
    }),
  );

  const AgentChannelChatTurnResponseSchema = registry.register(
    "AgentChannelChatTurnResponse",
    z.intersection(
      z.intersection(shared.ChatResponseSchema, AgentReplyEnvelopeCoreSchema),
      // The REST agent channel always emits the citation list, empty when none apply.
      z.object({ citations: z.array(schemas.CitationSchema) }),
    ),
  );

  const AgentChannelChatResponseSchema = registry.register(
    "AgentChannelChatResponse",
    z.union([
      AgentChannelChatTurnResponseSchema,
      shared.ChatBootstrapResponseSchema,
    ]).openapi({
      description: "A chat turn carries the agent reply envelope core beside the answer; a bootstrap greeting (`startConversation`) has no turn and carries none.",
    }),
  );

  Object.assign(schemas, {
    ChatOwnershipAckSchema,
    RoutinePendingInputSchema,
    RoutineTurnStateSchema,
    AgentReplyEnvelopeCoreSchema,
    McpConverseAskResponseSchema,
    AgentChannelChatTurnResponseSchema,
    AgentChannelChatResponseSchema,
  });
};
