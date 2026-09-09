import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import type { AgentRevisionService } from "../../../modules/agents/public.js";
import {
  requireWorkspaceSession,
  type WorkspaceSessionDependencies,
} from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import { presentRevisionDetail, presentRevisionState, presentRevisionSummary } from "./agentRevisionPresenters.js";
import { createRevisionCandidateBodySchema, publishRevisionBodySchema, revisionListQuerySchema } from "./agentRevisionRequestSchemas.js";

const agentParamsSchema = z.object({ agentId: z.string().uuid() });
const revisionParamsSchema = agentParamsSchema.extend({ revisionId: z.string().uuid() });

export type AgentRevisionRouteDependencies = WorkspaceSessionDependencies
  & Pick<AppDependencies, "accountAccessService" | "agentRepository">
  & { agentRevisionService: AgentRevisionService };

export const createAgentRevisionRoutes = (dependencies: AgentRevisionRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");

  router.get("/:agentId/revision-state", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, accountId, userId } = res.locals as { workspaceId: string; accountId: string; userId?: string };
      const { agentId } = agentParamsSchema.parse(req.params);
      const canPublish = await dependencies.accountAccessService.hasPermission({ accountId, userId, workspaceId, permission: "workspace.agents.manage" });
      const agent = await dependencies.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
      res.json(presentRevisionState(await dependencies.agentRevisionService.state(workspaceId, agentId), canPublish, agent?.proactiveGreetingEnabled ?? false));
    } catch (error) { next(error); }
  });

  router.post("/:agentId/revisions/candidates", workspaceSession, agentManage, validateBody(createRevisionCandidateBodySchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId } = agentParamsSchema.parse(req.params);
      const candidate = await dependencies.agentRevisionService.createCandidate(workspaceId, agentId, req.body.expectedDraftGeneration);
      res.status(201).json({ candidate: presentRevisionSummary(candidate) });
    } catch (error) { next(error); }
  });

  router.get("/:agentId/revisions", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId } = agentParamsSchema.parse(req.params);
      const { include } = revisionListQuerySchema.parse(req.query);
      const revisions = await dependencies.agentRevisionService.list(workspaceId, agentId);
      res.json({ revisions: revisions.filter((revision) => include !== "published" || revision.publishedAt !== null).map(presentRevisionSummary) });
    } catch (error) { next(error); }
  });

  router.get("/:agentId/revisions/:revisionId", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { agentId, revisionId } = revisionParamsSchema.parse(req.params);
      const revision = await dependencies.agentRevisionService.detail(workspaceId, agentId, revisionId);
      const baseRevision = revision.sourceBasePublishedRevisionId
        ? await dependencies.agentRevisionService.detail(workspaceId, agentId, revision.sourceBasePublishedRevisionId)
        : null;
      res.json({ revision: presentRevisionDetail(revision, baseRevision) });
    } catch (error) { next(error); }
  });

  router.post("/:agentId/revisions/:revisionId/publish", workspaceSession, agentManage, validateBody(publishRevisionBodySchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      const { agentId, revisionId } = revisionParamsSchema.parse(req.params);
      const publication = await dependencies.agentRevisionService.publish(workspaceId, agentId, accountId ?? null, { revisionId, ...req.body });
      const [state, agent] = await Promise.all([
        dependencies.agentRevisionService.state(workspaceId, agentId),
        dependencies.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId),
      ]);
      // An idempotent retry can arrive after a newer version became current. Its
      // response must still identify the release originally created by this key.
      const published = await dependencies.agentRevisionService.detail(workspaceId, agentId, publication.revisionId);
      res.json({
        publication: {
          id: publication.publicationId,
          revisionId: publication.revisionId,
          publishedAt: publication.publishedAt.toISOString(),
          idempotentReplay: publication.idempotentReplay,
          revision: presentRevisionSummary(published),
        },
        state: presentRevisionState(state, true, agent?.proactiveGreetingEnabled ?? false),
      });
    } catch (error) { next(error); }
  });

  return router;
};
