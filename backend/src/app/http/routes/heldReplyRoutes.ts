import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import type { ReviewTurnAuditRecord } from "../../../modules/chat/contracts/index.js";
import type { HeldReplyView, OwnershipActor } from "../../../modules/handoff/public.js";
import { AppError, badRequest, unauthorized } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { conversationParamsSchema } from "./conversationRouteSchemas.js";

type HeldReplyRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "heldReplies" | "reviewTurnAudits">;

type ReleaseRefusal = Extract<Awaited<ReturnType<AppDependencies["heldReplies"]["release"]>>, { ok: false }>["refusal"];

const DEFAULT_PAGE_SIZE = 50;

export const listHeldRepliesQuerySchema = z.object({
  attention: z.enum(["open", "all"]).optional(),
  agentId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const releaseHeldReplyRequestSchema = z.object({
  editedText: z.string().trim().min(1).max(20_000).optional(),
}).strict();

const heldReplyParamsSchema = conversationParamsSchema.extend({ heldReplyId: z.string().uuid() });

/** Session-only routes, so a signed-in teammate is always present; the check keeps a misread policy from recording an unattributed decision. */
const actorOf = (res: Response): OwnershipActor => {
  const { accountId, userId, workspaceId } = res.locals as { accountId: string; userId?: string; workspaceId: string };
  if (!userId) throw unauthorized("A signed-in teammate is required");
  return { accountId, userId, workspaceId };
};

const conversationIdOf = (req: Request): string => {
  const parsed = conversationParamsSchema.safeParse(req.params);
  if (!parsed.success) throw badRequest("Invalid request params", parsed.error.flatten());
  return parsed.data.conversationId;
};

const heldReplyOf = (req: Request): { conversationId: string; heldReplyId: string } => {
  const parsed = heldReplyParamsSchema.safeParse(req.params);
  if (!parsed.success) throw badRequest("Invalid request params", parsed.error.flatten());
  return parsed.data;
};

/**
 * The review turn's reasoning (FR-027): how its audit record says it went, and what it reported to
 * the held reply. Ids and codes only; null when no record of the review is readable.
 */
const traceOf = (heldReply: HeldReplyView, review: ReviewTurnAuditRecord | null) => review === null ? null : {
  turnId: review.turnId,
  outcome: review.answerOutcome,
  groundingVerdict: review.groundingVerdict,
  coverage: heldReply.facts.coverage,
  handoffReason: heldReply.facts.handoff.reason,
  suppressedEffects: heldReply.suppressedEffects.map((effect) => ({ skillName: effect.skillName })),
};

/**
 * The wire shape, selected field by field so the draft's presentation, its bound policy and its
 * review ref never reach a client.
 */
const presentHeldReply = (heldReply: HeldReplyView, review: ReviewTurnAuditRecord | null) => ({
  id: heldReply.id,
  conversationId: heldReply.conversationId,
  agentId: heldReply.agentId,
  state: heldReply.state,
  holdReason: heldReply.holdReason,
  facts: {
    grounding: heldReply.facts.grounding,
    coverage: heldReply.facts.coverage,
    handoff: { requested: heldReply.facts.handoff.requested, reason: heldReply.facts.handoff.reason },
    outcome: heldReply.facts.outcome,
  },
  dependsOnSuppressedAction: heldReply.dependsOnSuppressedAction,
  suppressedEffects: heldReply.suppressedEffects.map((effect) => ({ skillName: effect.skillName })),
  draftText: heldReply.draftText,
  editedText: heldReply.editedText,
  createdAt: heldReply.createdAt.toISOString(),
  decidedAt: heldReply.decidedAt?.toISOString() ?? null,
  releaserUserId: heldReply.releaserUserId,
  editorUserId: heldReply.editorUserId,
  attentionOpen: heldReply.attentionOpen,
  trace: traceOf(heldReply, review),
});

type HeldReplyWire = ReturnType<typeof presentHeldReply>;

/** Presents held replies with their review turns, read in one pass for a page. */
const heldReplyPresenter = (reviews: AppDependencies["reviewTurnAudits"]) =>
  async (workspaceId: string, heldReplies: readonly HeldReplyView[]): Promise<HeldReplyWire[]> => {
    const found = await reviews.find(workspaceId, heldReplies.map((heldReply) => ({
      conversationId: heldReply.conversationId,
      requestMessageId: heldReply.answersMessageId,
      recordedBy: heldReply.createdAt,
    })));
    return heldReplies.map((heldReply, index) => presentHeldReply(heldReply, found[index] ?? null));
  };

const REFUSALS: Record<ReleaseRefusal, { code: string; message: string }> = {
  not_pending: { code: "held_reply_not_pending", message: "The held reply is no longer pending" },
  ownership_changed: { code: "ownership_changed", message: "The conversation changed hands since the reply was held" },
  policy_changed: { code: "policy_changed", message: "The channel's settings changed since the reply was held" },
  channel_not_ready: { code: "channel_not_ready", message: "The conversation's channel cannot send this reply" },
};

// Every refusal carries the held reply as it is now, so the caller can re-render without a re-read.
const refused = (refusal: ReleaseRefusal, current: HeldReplyWire | null): AppError =>
  new AppError(409, REFUSALS[refusal].code, REFUSALS[refusal].message, { heldReply: current });

const handle = (work: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    work(req, res).catch(next);
  };

/**
 * Replies an agent wrote in review that wait for a teammate, and a teammate's decisions on them.
 * Every route is session-only under the Inbox's permission (apiPrincipalRoutePolicy.ts).
 */
export const createHeldReplyRoutes = (dependencies: HeldReplyRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const takeoverPermission = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");
  const heldReplies = dependencies.heldReplies;
  const present = heldReplyPresenter(dependencies.reviewTurnAudits);
  const presentOne = async (workspaceId: string, heldReply: HeldReplyView): Promise<HeldReplyWire> =>
    (await present(workspaceId, [heldReply]))[0];
  const presentMaybe = async (workspaceId: string, heldReply: HeldReplyView | null): Promise<HeldReplyWire | null> =>
    (heldReply ? presentOne(workspaceId, heldReply) : null);

  router.get("/held-replies", workspaceSession, takeoverPermission, validateQuery(listHeldRepliesQuerySchema), handle(async (req, res) => {
    const query = req.query as z.infer<typeof listHeldRepliesQuerySchema>;
    const actor = actorOf(res);
    const page = await heldReplies.list(actor, {
      attention: query.attention ?? "open",
      agentId: query.agentId,
      cursor: query.cursor,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    res.status(200).json({ items: await present(actor.workspaceId, page.items), nextCursor: page.nextCursor });
  }));

  router.get("/conversations/:conversationId/held-reply", workspaceSession, takeoverPermission, handle(async (req, res) => {
    const actor = actorOf(res);
    const { heldReply } = await heldReplies.current(actor, conversationIdOf(req));
    res.status(200).json({ heldReply: await presentMaybe(actor.workspaceId, heldReply) });
  }));

  router.post(
    "/conversations/:conversationId/held-replies/:heldReplyId/release",
    workspaceSession,
    takeoverPermission,
    validateBody(releaseHeldReplyRequestSchema.optional()),
    handle(async (req, res) => {
      const target = heldReplyOf(req);
      const body = req.body as z.infer<typeof releaseHeldReplyRequestSchema> | undefined;
      const actor = actorOf(res);
      const result = await heldReplies.release(actor, { ...target, editedText: body?.editedText ?? null });
      if (!result.ok) throw refused(result.refusal, await presentMaybe(actor.workspaceId, result.current));
      res.status(201).json({ heldReply: await presentOne(actor.workspaceId, result.heldReply), messageId: result.messageId, delivery: "queued" });
    }),
  );

  router.post("/conversations/:conversationId/held-replies/:heldReplyId/discard", workspaceSession, takeoverPermission, handle(async (req, res) => {
    const actor = actorOf(res);
    const result = await heldReplies.discard(actor, heldReplyOf(req));
    if (!result.ok) throw refused(result.refusal, await presentMaybe(actor.workspaceId, result.current));
    res.status(200).json(await presentOne(actor.workspaceId, result.heldReply));
  }));

  return router;
};
