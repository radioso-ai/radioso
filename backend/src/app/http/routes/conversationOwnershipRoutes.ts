import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { AppError, badRequest, notFound } from "../../../shared/domain/errors.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { conversationParamsSchema } from "./conversationRouteSchemas.js";

type ConversationOwnershipRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  | "accountRepository"
  | "auditService"
  | "conversationForkService"
  | "conversationOwnershipRepository"
  | "conversationRepository"
  | "operatorReplyService"
  | "userRepository"
  | "workspaceRepository"
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
  toAccountId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

const versionBodySchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
}).strict();

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

const requireTransferTargetInWorkspace = async (
  dependencies: ConversationOwnershipRouteDependencies,
  workspaceId: string,
  accountId: string,
): Promise<void> => {
  const workspace = await dependencies.workspaceRepository.findById(workspaceId);
  if (!workspace || workspace.accountId !== accountId) {
    throw notFound("Transfer target not found");
  }
};

const resolveDisplayName = async (
  dependencies: ConversationOwnershipRouteDependencies,
  input: { accountId: string; userId?: string },
): Promise<string> => {
  const account = await dependencies.accountRepository.findById(input.accountId);
  if (account?.name && account.name.trim().length > 0) {
    return account.name;
  }

  if (input.userId) {
    const user = await dependencies.userRepository.findById(input.userId);
    if (user?.email && user.email.trim().length > 0) {
      return user.email;
    }
  }

  return "Operator";
};

const conflictWithCurrentOwnership = (record: unknown): AppError =>
  new AppError(409, "conflict", "Conversation ownership changed", { ownership: record });

export const createConversationOwnershipRoutes = (
  dependencies: ConversationOwnershipRouteDependencies,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const takeoverPermission = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");

  router.post("/:conversationId/takeover", workspaceSession, takeoverPermission, validateBody(takeoverBodySchema), async (req, res, next) => {
    try {
      const { accountId, userId, workspaceId } = res.locals as { accountId: string; userId?: string; workspaceId: string };
      const conversationId = parseConversationId(req.params);
      await requireConversationInWorkspace(dependencies, workspaceId, conversationId);
      const displayName = await resolveDisplayName(dependencies, { accountId, userId });
      const body = req.body as z.infer<typeof takeoverBodySchema>;
      const result = await dependencies.conversationOwnershipRepository.takeOver({
        conversationId,
        workspaceId,
        accountId,
        displayName,
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
          reason: body.reason,
        },
      });

      res.status(200).json({ ownership: result.record });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/reply", workspaceSession, takeoverPermission, validateBody(replyBodySchema), async (req, res, next) => {
    try {
      const { accountId, userId, workspaceId } = res.locals as { accountId: string; userId?: string; workspaceId: string };
      const conversationId = parseConversationId(req.params);
      await requireConversationInWorkspace(dependencies, workspaceId, conversationId);
      const displayName = await resolveDisplayName(dependencies, { accountId, userId });
      const body = req.body as z.infer<typeof replyBodySchema>;
      await requireOwnershipVersion(dependencies, conversationId, body.expectedVersion);
      const message = await dependencies.operatorReplyService.reply({
        conversationId,
        workspaceId,
        accountId,
        displayName,
        message: body.message,
      });

      res.status(201).json({ message });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/transfer", workspaceSession, takeoverPermission, validateBody(transferBodySchema), async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
      const conversationId = parseConversationId(req.params);
      const body = req.body as z.infer<typeof transferBodySchema>;
      await requireConversationInWorkspace(dependencies, workspaceId, conversationId);
      await requireTransferTargetInWorkspace(dependencies, workspaceId, body.toAccountId);
      const targetDisplayName = await resolveDisplayName(dependencies, { accountId: body.toAccountId });
      const result = await dependencies.conversationOwnershipRepository.transfer({
        conversationId,
        accountId: body.toAccountId,
        displayName: targetDisplayName,
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
          targetAccountId: body.toAccountId,
        },
      });

      res.status(200).json({ ownership: result.record });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:conversationId/handback", workspaceSession, takeoverPermission, validateBody(versionBodySchema), async (req, res, next) => {
    try {
      const { accountId, workspaceId } = res.locals as { accountId: string; workspaceId: string };
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
        },
      });

      res.status(200).json({ ownership: result.record });
    } catch (error) {
      next(error);
    }
  });

  // Forking a conversation into a test session is a general conversation operation, not a HITL
  // ownership action, so it is gated by workspaceSession only (no takeover permission). It is
  // co-located here to reuse the shared workspace-scoped conversation existence guard.
  router.post("/:conversationId/fork", workspaceSession, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const sourceConversationId = parseConversationId(req.params);
      await requireConversationInWorkspace(dependencies, workspaceId, sourceConversationId);
      const { conversationId } = await dependencies.conversationForkService.forkForTest(
        workspaceId,
        sourceConversationId,
      );
      res.status(200).json({ conversationId });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
