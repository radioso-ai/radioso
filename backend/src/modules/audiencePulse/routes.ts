import { Router } from "express";

import type { AppDependencies } from "../../app/server/types.js";
import { badRequest, notFound } from "../../shared/domain/errors.js";
import {
  requireDashboardWorkspaceSession,
  type DashboardWorkspaceSessionDependencies,
} from "../../app/http/middleware/requireDashboardWorkspaceSession.js";
import { requireWorkspacePermission } from "../../app/http/middleware/requirePermission.js";
import { audiencePulseEvidenceAnchorRequestSchema, type AudiencePulsePort } from "./contracts.js";

export type AudiencePulseRouteDependencies = DashboardWorkspaceSessionDependencies
  & Pick<AppDependencies, "accountAccessService" | "env">;

export const createAudiencePulseRoutes = (
  dependencies: AudiencePulseRouteDependencies,
  service: AudiencePulsePort,
): Router => {
  const router = Router();
  const dashboardSession = requireDashboardWorkspaceSession(dependencies);
  const qualityRead = requireWorkspacePermission(dependencies, "workspace.quality.read");
  const historyRead = requireWorkspacePermission(dependencies, "workspace.history.read");

  router.get("/", dashboardSession, qualityRead, async (_req, res, next) => {
    try {
      const { accountId, userId, workspaceId } = res.locals as {
        accountId: string;
        userId: string;
        workspaceId: string;
      };
      res.status(200).json(await service.read({ accountId, userId, workspaceId }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/evidence-anchor", dashboardSession, historyRead, async (req, res, next) => {
    try {
      const body = audiencePulseEvidenceAnchorRequestSchema.safeParse(req.body ?? {});
      if (!body.success) {
        next(badRequest("Invalid Audience Pulse evidence anchor", body.error.flatten()));
        return;
      }
      const { accountId, userId, workspaceId } = res.locals as {
        accountId: string;
        userId: string;
        workspaceId: string;
      };
      const anchor = await service.readEvidenceAnchor({
        accountId,
        userId,
        workspaceId,
        ...body.data,
      });
      if (!anchor) {
        next(notFound("Audience Pulse evidence source was not found"));
        return;
      }
      res.status(200).json(anchor);
    } catch (error) {
      next(error);
    }
  });

  router.post("/", dashboardSession, qualityRead, async (req, res, next) => {
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const { accountId, userId, workspaceId } = res.locals as {
        accountId: string;
        userId: string;
        workspaceId: string;
      };
      const result = await service.refresh({ accountId, userId, workspaceId, signal: controller.signal });
      if (result.kind === "busy") {
        res.status(409).json({
          error: {
            code: "AUDIENCE_PULSE_REFRESH_IN_PROGRESS",
            message: "Audience Pulse refresh is already in progress",
          },
        });
        return;
      }
      if (result.kind === "usage_limited") {
        res.status(429).json({
          error: {
            code: "AUDIENCE_PULSE_USAGE_LIMITED",
            message: "Audience Pulse refresh capacity is currently exhausted",
          },
        });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      next(error);
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
    }
  });

  return router;
};
