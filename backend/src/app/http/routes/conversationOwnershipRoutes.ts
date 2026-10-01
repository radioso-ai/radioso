import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import {
  presentOwnership,
  type ConversationOwnershipRecord,
  type OwnershipActor,
} from "../../../modules/handoff/public.js";
import { AppError, badRequest, unauthorized } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { conversationParamsSchema } from "./conversationRouteSchemas.js";

type ConversationOwnershipRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "conversationOperatorDirectory" | "conversationOwnershipService"
>;

const takeoverBodySchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

const replyBodySchema = z.object({
  message: z.string().trim().min(1).max(50_000),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

const transferBodySchema = z.object({
  toUserId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

const versionBodySchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
}).strict();

// Ownership routes are session-only, so a signed-in teammate is always present; the check keeps
// a misconfigured policy from ever recording an ownerless claim.
const readActor = (locals: Record<string, unknown>): OwnershipActor => {
  const { accountId, userId, workspaceId } = locals as { accountId: string; userId?: string; workspaceId: string };
  if (!userId) {
    throw unauthorized("A signed-in teammate is required");
  }
  return { accountId, userId, workspaceId };
};

const parseConversationId = (params: unknown): string => {
  const parsed = conversationParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw badRequest("Invalid request params", parsed.error.flatten());
  }

  return parsed.data.conversationId;
};

type Refusal = { ok: false; refusal: "stale" | "held_by_teammate"; record: ConversationOwnershipRecord | null };

// Both refusals carry the ownership as it is now, so the caller can re-render without a re-read.
const refused = (result: Refusal): AppError =>
  new AppError(
    409,
    "conflict",
    result.refusal === "held_by_teammate" ? "Another teammate is handling this conversation" : "Conversation ownership changed",
    { ownership: result.record ? presentOwnership(result.record) : null },
  );

export const createConversationOwnershipRoutes = (
  dependencies: ConversationOwnershipRouteDependencies,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const takeoverPermission = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");
  const ownership = dependencies.conversationOwnershipService;

  router.get("/operators", workspaceSession, takeoverPermission, async (_req, res, next) => {
    try {
      const { accountId, workspaceId } = readActor(res.locals);
      const operators = await dependencies.conversationOperatorDirectory.list({ accountId, workspaceId });

      res.status(200).json({ operators });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/takeover", workspaceSession, takeoverPermission, validateBody(takeoverBodySchema), async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof takeoverBodySchema>;
      const result = await ownership.takeOver(readActor(res.locals), {
        conversationId: parseConversationId(req.params),
        reason: body.reason,
      });
      if (!result.ok) {
        throw refused(result);
      }

      res.status(200).json({ ownership: presentOwnership(result.record) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/reply", workspaceSession, takeoverPermission, validateBody(replyBodySchema), async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof replyBodySchema>;
      const result = await ownership.reply(readActor(res.locals), {
        conversationId: parseConversationId(req.params),
        message: body.message,
        expectedVersion: body.expectedVersion,
      });
      if (!result.ok) {
        throw refused(result);
      }

      res.status(201).json({ message: result.message, ownership: presentOwnership(result.record) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/transfer", workspaceSession, takeoverPermission, validateBody(transferBodySchema), async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof transferBodySchema>;
      // Transferring to yourself is how a teammate takes a conversation someone else holds.
      const result = await ownership.transfer(readActor(res.locals), {
        conversationId: parseConversationId(req.params),
        toUserId: body.toUserId,
        expectedVersion: body.expectedVersion,
      });
      if (!result.ok) {
        throw refused(result);
      }

      res.status(200).json({ ownership: presentOwnership(result.record) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/handback", workspaceSession, takeoverPermission, validateBody(versionBodySchema), async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof versionBodySchema>;
      const result = await ownership.handBack(readActor(res.locals), {
        conversationId: parseConversationId(req.params),
        expectedVersion: body.expectedVersion,
      });
      if (!result.ok) {
        throw refused(result);
      }

      res.status(200).json({ ownership: presentOwnership(result.record) });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
