import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import type { DeliveryFailureActor, DeliveryFailureRecord } from "../../../modules/customerReplyDelivery/public.js";
import { badRequest, unauthorized } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody, validateQuery } from "../middleware/validate.js";

type DeliveryFailureRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "deliveryFailures">;

const DEFAULT_PAGE_SIZE = 50;

export const listDeliveryFailuresQuerySchema = z.object({
  state: z.enum(["open", "all"]).optional(),
  agentId: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

export const resolveDeliveryFailureRequestSchema = z.object({
  decision: z.enum(["marked_sent", "resend"]),
}).strict();

const failureIdSchema = z.string().uuid();

const failureIdOf = (req: Request): string => {
  const parsed = failureIdSchema.safeParse(req.params.failureId);
  if (!parsed.success) throw badRequest("Invalid failureId");
  return parsed.data;
};

/** Session-only routes, so a signed-in teammate is always present; the check keeps a misread policy from recording an unattributed decision. */
const actorOf = (res: Response): DeliveryFailureActor => {
  const { accountId, userId, workspaceId } = res.locals as { accountId: string; userId?: string; workspaceId: string };
  if (!userId) throw unauthorized("A signed-in teammate is required");
  return { accountId, userId, workspaceId };
};

/** The wire shape: who cleared a failure stays out of it, as the activity feed already names them. */
const presentFailure = (failure: DeliveryFailureRecord) => ({
  id: failure.id,
  conversationId: failure.conversationId,
  messageId: failure.messageId,
  provider: failure.provider,
  kind: failure.kind,
  detailCode: failure.detailCode,
  openedAt: failure.openedAt.toISOString(),
  clearedAt: failure.clearedAt?.toISOString() ?? null,
  clearReason: failure.clearReason,
});

const handle = (work: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    work(req, res).catch(next);
  };

/**
 * Replies that may not have reached the customer, and a teammate's decisions on them. Every route
 * is session-only under the Inbox's permission (apiPrincipalRoutePolicy.ts).
 */
export const createDeliveryFailureRoutes = (dependencies: DeliveryFailureRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const takeoverPermission = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");
  const failures = dependencies.deliveryFailures;

  router.get("/", workspaceSession, takeoverPermission, validateQuery(listDeliveryFailuresQuerySchema), handle(async (req, res) => {
    const query = req.query as z.infer<typeof listDeliveryFailuresQuerySchema>;
    const page = await failures.list(actorOf(res).workspaceId, {
      state: query.state ?? "open",
      agentId: query.agentId,
      cursor: query.cursor,
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
    });
    res.status(200).json({ items: page.items.map(presentFailure), nextCursor: page.nextCursor });
  }));

  router.post("/:failureId/acknowledge", workspaceSession, takeoverPermission, handle(async (req, res) => {
    res.status(200).json(presentFailure(await failures.acknowledge(actorOf(res), failureIdOf(req))));
  }));

  router.post("/:failureId/resolve", workspaceSession, takeoverPermission, validateBody(resolveDeliveryFailureRequestSchema), handle(async (req, res) => {
    const { decision } = req.body as z.infer<typeof resolveDeliveryFailureRequestSchema>;
    res.status(200).json(presentFailure(await failures.resolve(actorOf(res), failureIdOf(req), decision)));
  }));

  return router;
};
