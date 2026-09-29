import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import {
  presentOwnership,
  type ConversationOperator,
  type ConversationOwnershipRecord,
} from "../../../modules/handoff/public.js";
import { AppError, badRequest, notFound, unauthorized } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { conversationParamsSchema } from "./conversationRouteSchemas.js";

type ConversationOwnershipRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  | "auditService"
  | "conversationOperatorDirectory"
  | "conversationOwnershipRepository"
  | "conversationRepository"
  | "conversationTransferNotices"
  | "operatorIdentityResolver"
  | "operatorReplyService"
  | "workspaceInvalidationPublisher"
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

interface OperatorScope {
  accountId: string;
  userId: string;
  workspaceId: string;
}

// Ownership routes are session-only, so a signed-in teammate is always present; the check keeps
// a misconfigured policy from ever recording an ownerless claim.
const readOperatorScope = (locals: Record<string, unknown>): OperatorScope => {
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

const requireConversationInWorkspace = async (
  dependencies: ConversationOwnershipRouteDependencies,
  workspaceId: string,
  conversationId: string,
): Promise<void> => {
  const conversation = await dependencies.conversationRepository.findByIdAndWorkspaceId(conversationId, workspaceId);
  if (!conversation) {
    throw notFound("Conversation not found");
  }
};

const requireOwnershipVersion = async (
  dependencies: ConversationOwnershipRouteDependencies,
  conversationId: string,
  expectedVersion: number,
): Promise<void> => {
  const ownership = await dependencies.conversationOwnershipRepository.load(conversationId);
  if (ownership?.state !== "human_owned" || ownership.version !== expectedVersion) {
    throw conflictWithCurrentOwnership(ownership);
  }
};

// Unknown users, users of another organisation, and teammates who cannot own conversations here
// all read as "not found", so the route never confirms who exists outside the workspace.
const requireTransferTarget = async (
  dependencies: ConversationOwnershipRouteDependencies,
  scope: OperatorScope,
  toUserId: string,
): Promise<ConversationOperator> => {
  const target = await dependencies.conversationOperatorDirectory.find({
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    userId: toUserId,
  });
  if (!target) {
    throw notFound("Transfer target not found");
  }
  return target;
};

const conflictWithCurrentOwnership = (record: ConversationOwnershipRecord | null): AppError =>
  new AppError(409, "conflict", "Conversation ownership changed", {
    ownership: record ? presentOwnership(record) : null,
  });

export const createConversationOwnershipRoutes = (
  dependencies: ConversationOwnershipRouteDependencies,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const takeoverPermission = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");

  router.get("/operators", workspaceSession, takeoverPermission, async (_req, res, next) => {
    try {
      const { accountId, workspaceId } = readOperatorScope(res.locals);
      const operators = await dependencies.conversationOperatorDirectory.list({ accountId, workspaceId });

      res.status(200).json({ operators });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/takeover", workspaceSession, takeoverPermission, validateBody(takeoverBodySchema), async (req, res, next) => {
    try {
      const { accountId, userId, workspaceId } = readOperatorScope(res.locals);
      const conversationId = parseConversationId(req.params);
      await requireConversationInWorkspace(dependencies, workspaceId, conversationId);
      const operator = await dependencies.operatorIdentityResolver.resolve({ accountId, userId });
      const body = req.body as z.infer<typeof takeoverBodySchema>;
      const result = await dependencies.conversationOwnershipRepository.takeOver({
        conversationId,
        workspaceId,
        accountId,
        userId: operator.userId,
        displayName: operator.teammateLabel,
      });

      if (!result.ok) {
        next(conflictWithCurrentOwnership(result.record));
        return;
      }
      if (result.changed) {
        dependencies.workspaceInvalidationPublisher.enqueue(workspaceId, ["conversation.ownership_changed"]);
      }

      await dependencies.auditService.record({
        accountId,
        workspaceId,
        eventType: "hitl.ownership",
        eventStatus: "success",
        metadata: {
          action: "taken_over",
          conversationId,
          ownerAccountId: accountId,
          actorUserId: userId,
          reason: body.reason,
        },
      });

      res.status(200).json({ ownership: presentOwnership(result.record) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/reply", workspaceSession, takeoverPermission, validateBody(replyBodySchema), async (req, res, next) => {
    try {
      const { accountId, userId, workspaceId } = readOperatorScope(res.locals);
      const conversationId = parseConversationId(req.params);
      await requireConversationInWorkspace(dependencies, workspaceId, conversationId);
      const body = req.body as z.infer<typeof replyBodySchema>;
      await requireOwnershipVersion(dependencies, conversationId, body.expectedVersion);
      const message = await dependencies.operatorReplyService.reply({
        conversationId,
        workspaceId,
        accountId,
        userId,
        message: body.message,
      });

      res.status(201).json({ message });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/transfer", workspaceSession, takeoverPermission, validateBody(transferBodySchema), async (req, res, next) => {
    try {
      const scope = readOperatorScope(res.locals);
      const { accountId, userId, workspaceId } = scope;
      const conversationId = parseConversationId(req.params);
      const body = req.body as z.infer<typeof transferBodySchema>;
      await requireConversationInWorkspace(dependencies, workspaceId, conversationId);
      const target = await requireTransferTarget(dependencies, scope, body.toUserId);
      // Transferring to yourself is how a teammate takes a conversation someone else holds.
      const result = await dependencies.conversationOwnershipRepository.transfer({
        conversationId,
        accountId,
        userId: target.userId,
        displayName: target.label,
        expectedVersion: body.expectedVersion,
      });

      if (!result.ok) {
        next(conflictWithCurrentOwnership(result.record));
        return;
      }
      if (result.changed) {
        dependencies.workspaceInvalidationPublisher.enqueue(workspaceId, ["conversation.ownership_changed"]);
      }

      await dependencies.auditService.record({
        accountId,
        workspaceId,
        eventType: "hitl.ownership",
        eventStatus: "success",
        metadata: {
          action: "transferred",
          conversationId,
          actorUserId: userId,
          targetUserId: target.userId,
        },
      });
      if (result.changed) {
        // Queued, not sent: delivery runs on the action worker, so the transfer never waits on the
        // mail provider. Awaited because the host throttles CPU once the response is sent; the
        // call never rejects, so a lost notice cannot fail the transfer.
        await dependencies.conversationTransferNotices.queueForRecipient({
          accountId,
          workspaceId,
          conversationId,
          ownershipVersion: result.record.version,
          actorUserId: userId,
          recipientUserId: target.userId,
        });
      }

      res.status(200).json({ ownership: presentOwnership(result.record) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/handback", workspaceSession, takeoverPermission, validateBody(versionBodySchema), async (req, res, next) => {
    try {
      const { accountId, userId, workspaceId } = readOperatorScope(res.locals);
      const conversationId = parseConversationId(req.params);
      const body = req.body as z.infer<typeof versionBodySchema>;
      await requireConversationInWorkspace(dependencies, workspaceId, conversationId);
      const result = await dependencies.conversationOwnershipRepository.handBack({
        conversationId,
        expectedVersion: body.expectedVersion,
      });

      if (!result.ok) {
        next(conflictWithCurrentOwnership(result.record));
        return;
      }
      if (result.changed) {
        dependencies.workspaceInvalidationPublisher.enqueue(workspaceId, ["conversation.ownership_changed"]);
      }

      await dependencies.auditService.record({
        accountId,
        workspaceId,
        eventType: "hitl.ownership",
        eventStatus: "success",
        metadata: {
          action: "handed_back",
          conversationId,
          actorUserId: userId,
        },
      });

      res.status(200).json({ ownership: presentOwnership(result.record) });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
