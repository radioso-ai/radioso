import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { rotatedPublicIdInput } from "../../../modules/agents/public.js";
import { badRequest } from "../../../shared/domain/errors.js";

const agentParamsSchema = z.object({ agentId: z.string().uuid() });

type AgentPublicIdentityRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  | "accountAccessService"
  | "agentService"
  | "auditService"
>;

/**
 * Rotation of an agent's public id. Separate from `agentRoutes.ts` because that file already
 * carries the agent CRUD, channel credentials, directives, routines, and the logo surface; the
 * public identity is its own boundary and the discovery slices add to it.
 *
 * Rotation is a revocation, not a settings save: the walk-in principal carries the public id and
 * the converse surface compares it to the agent's current one on every request, so a new id drops
 * every connected agent on its next call. That is why it is a deliberate POST behind a confirm in
 * the dashboard rather than a field on the update body, and why it records an audit event the
 * older token-rotation routes do not.
 */
export const createAgentPublicIdentityRoutes = (dependencies: AgentPublicIdentityRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentManage = requireWorkspacePermission(
    dependencies,
    "workspace.agents.manage",
    (_req, res) => String(res.locals.workspaceId ?? ""),
  );

  router.post("/:agentId/public-id/rotate", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      const { agentId } = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, agentId);
      if (!current.publicId) {
        throw badRequest("This agent has no public id yet; publishing its agent card mints one");
      }

      const agent = await dependencies.agentService.update(workspaceId, agentId, rotatedPublicIdInput());

      await dependencies.auditService.record({
        accountId: accountId ?? null,
        workspaceId,
        eventType: "agent.public_id.rotated",
        eventStatus: "success",
        // Neither the retired id nor its replacement: both are live-or-lately-live access keys.
        metadata: { agentId, publicAgentAccessEnabled: agent.publicAgentAccessEnabled },
      });

      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
