import { Router } from "express";
import { z } from "zod";
import { requireWorkspacePermission } from "../../../app/http/middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../../../app/http/middleware/requireWorkspaceSession.js";
import { validateBody } from "../../../app/http/middleware/validate.js";
import { startRevisionEvalRunSchema } from "../../../app/http/routes/agentRevisionRequestSchemas.js";
import type { EvalCase } from "../domain/types.js";
import type { RevisionEvalEvidenceState, RevisionEvalRun, RevisionEvalRunService } from "../services/revisionEvalRun.js";

const runParams = z.object({ runId: z.string().uuid() });
const retryParams = runParams.extend({ revisionId: z.string().uuid(), caseId: z.string().uuid() });
export interface RevisionEvalRouteDependencies extends WorkspaceSessionDependencies { revisionEvalRunService: RevisionEvalRunService; }
const stable = (value: unknown): string => JSON.stringify(value);
const externalState = (state: string) => state === "pending" ? "running" : state;
export const revisionEvalEvidenceStateForCase = (
  current: EvalCase | null,
  frozen: EvalCase,
): RevisionEvalEvidenceState => {
  if (!current || current.snapshotId !== frozen.snapshotId || current.executionMode !== frozen.executionMode || stable(current.assertions) !== stable(frozen.assertions)) {
    return "configuration_changed";
  }
  // Case configuration is the only freshness signal currently tracked here.
  // Live providers, documents, and other unscoped dependencies remain unknown.
  return "comparability_unknown";
};
const present = async (run: RevisionEvalRun, service: RevisionEvalRunService) => ({ id: run.id, state: externalState(run.state), sides: await Promise.all(run.sides.map(async (side) => {
  let evidenceState: RevisionEvalEvidenceState = "comparability_unknown";
  const cases = await Promise.all(side.cases.map(async (item) => {
    const current = await service.currentCase(run.workspaceId, item.caseId);
    if (revisionEvalEvidenceStateForCase(current, item.frozenCase) === "configuration_changed") evidenceState = "configuration_changed";
    return { caseId: item.caseId, state: item.state === "pending" ? "running" : item.state, outcome: item.outcome };
  }));
  const currentRevision = await service.revisionSummary(run.workspaceId, run.agentId, side.revisionId);
  const versionNumber = currentRevision?.publishedVersion ?? side.revision.publishedVersion;
  return { revisionId: side.revisionId, revision: { id: side.revisionId, versionNumber, label: versionNumber === null ? `Draft · ${side.revision.createdAt.toISOString()}` : `v${versionNumber}` }, state: externalState(side.state), evidenceState, cases };
})) });

/** Operator-only candidate eval API; never mounted by public channel routers. */
export const createRevisionEvalRoutes = (dependencies: RevisionEvalRouteDependencies): Router => {
  const router = Router(); const session = requireWorkspaceSession(dependencies); const manage = requireWorkspacePermission(dependencies, "workspace.agents.manage"); const read = requireWorkspacePermission(dependencies, "workspace.agents.read");
  router.post("/revision-runs", session, manage, validateBody(startRevisionEvalRunSchema), async (req, res, next) => {
    try { const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string | null }; const run = await dependencies.revisionEvalRunService.start({ workspaceId, accountId: accountId ?? null, ...req.body }); res.status(201).json(await present(run, dependencies.revisionEvalRunService)); } catch (error) { next(error); }
  });
  router.get("/revision-runs/:runId", session, read, async (req, res, next) => {
    try { const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string | null }; const { runId } = runParams.parse(req.params); const run = await dependencies.revisionEvalRunService.get({ workspaceId, runId, accountId: accountId ?? null }); res.status(200).json(await present(run, dependencies.revisionEvalRunService)); } catch (error) { next(error); }
  });
  router.post("/revision-runs/:runId/sides/:revisionId/cases/:caseId/retry", session, manage, async (req, res, next) => {
    try { const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string | null }; const { runId, revisionId, caseId } = retryParams.parse(req.params); const run = await dependencies.revisionEvalRunService.retry({ workspaceId, runId, revisionId, caseId, accountId: accountId ?? null }); res.status(200).json(await present(run, dependencies.revisionEvalRunService)); } catch (error) { next(error); }
  });
  return router;
};
