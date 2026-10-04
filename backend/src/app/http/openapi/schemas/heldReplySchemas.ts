import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { HELD_REPLY_STATES } from "../../../../modules/handoff/public.js";
import { listHeldRepliesQuerySchema, releaseHeldReplyRequestSchema } from "../../routes/heldReplyRoutes.js";
import type { OpenApiSchemas } from "../openApiRegistry.js";

/** Replies an agent wrote in review that wait for a teammate (specs/1403-email-channel/contracts/openapi-additions.md §2). */
export const registerHeldReplySchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemas) => {
  const HeldReplySchema = registry.register("HeldReply", z.object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    agentId: z.string().uuid().nullable().openapi({ description: "The agent whose review wrote the draft." }),
    state: z.enum(HELD_REPLY_STATES).openapi({
      description: "`pending`: waiting for a teammate. `queued_auto`: queued to send automatically. `released`: sent as the agent wrote it. `edited`: sent as a teammate edited it. `discarded`: set aside by a teammate. `superseded`: replaced by a newer message, a takeover, an operator reply or a policy change.",
    }),
    holdReason: z.string().openapi({ description: "The producing channel's code for why the reply was held." }),
    facts: z.object({
      grounding: z.string(),
      coverage: z.string(),
      handoff: z.object({ requested: z.boolean(), reason: z.string().nullable() }),
      outcome: z.string(),
    }).openapi({ description: "What the review turn found, as the producing channel's codes." }),
    dependsOnSuppressedAction: z.boolean().openapi({ description: "The draft relies on an action the review turn was not allowed to run." }),
    suppressedEffects: z.array(z.object({ skillName: z.string() })),
    draftText: z.string().openapi({ description: "The agent's draft, kept as written after an edited release." }),
    editedText: z.string().nullable().openapi({ description: "The teammate's text an edited release sent; null otherwise." }),
    createdAt: z.string().datetime(),
    decidedAt: z.string().datetime().nullable(),
    releaserUserId: z.string().nullable(),
    editorUserId: z.string().nullable(),
    attentionOpen: z.boolean().openapi({ description: "Whether the conversation still waits for a teammate because of this reply. A discarded draft keeps it open until a teammate replies or takes over." }),
    trace: z.union([schemas.TurnTraceEnvelopeSchema, z.null()]),
  }));
  const HeldReplyPageSchema = registry.register("HeldReplyPage", z.object({
    items: z.array(HeldReplySchema),
    nextCursor: z.string().nullable().openapi({ description: "Pass back as `cursor` for the next page; null on the last one." }),
  }));
  const CurrentHeldReplyResponseSchema = registry.register("CurrentHeldReplyResponse", z.object({
    heldReply: z.union([HeldReplySchema, z.null()]).openapi({ description: "The conversation's newest held reply, whatever its state; null when it has none." }),
  }));
  const HeldReplyReleaseResultSchema = registry.register("HeldReplyReleaseResult", z.object({
    heldReply: HeldReplySchema,
    messageId: z.string().uuid().openapi({ description: "The message the release wrote: the agent's draft, or the teammate's edit." }),
    delivery: z.literal("queued"),
  }));

  return {
    HeldReplySchema,
    HeldReplyPageSchema,
    CurrentHeldReplyResponseSchema,
    HeldReplyReleaseResultSchema,
    ReleaseHeldReplyRequestSchema: registry.register("ReleaseHeldReplyRequest", releaseHeldReplyRequestSchema),
    ListHeldRepliesQuerySchema: listHeldRepliesQuerySchema,
  };
};
