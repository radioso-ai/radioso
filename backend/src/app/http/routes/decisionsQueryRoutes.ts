import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import type { PendingDecisionRecord } from "../../../modules/approvals/public.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";

type DecisionsQueryRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "accountAccessService" | "approvalDecisionService"
>;

const presentPendingDecision = (record: PendingDecisionRecord) => ({
  handle: record.handle,
  conversationId: record.conversationId,
  agentId: record.agentId,
  routineId: record.routineId,
  stepId: record.stepId,
  reason: record.reason,
  options: record.options.map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description !== undefined ? { description: option.description } : {}),
  })),
  contentHash: record.contentHash,
  deadline: record.deadline ? record.deadline.toISOString() : null,
  createdAt: record.createdAt.toISOString(),
});

export const createDecisionsQueryRoutes = (dependencies: DecisionsQueryRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const decisionPermission = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");

  router.get("/", workspaceSession, decisionPermission, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const decisions = await dependencies.approvalDecisionService.listPending(workspaceId);
      res.status(200).json({ decisions: decisions.map(presentPendingDecision) });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
