import { Router } from "express";
import type { z } from "zod";

import { requireWorkspacePermission } from "../../app/http/middleware/requirePermission.js";
import {
  requireWorkspaceSession,
  type WorkspaceSessionDependencies,
} from "../../app/http/middleware/requireWorkspaceSession.js";
import type { AppDependencies } from "../../app/server/types.js";
import { badRequest, notFound } from "../../shared/domain/errors.js";
import {
  contentPlanListQuerySchema,
  contentPlanTopicDetailParamsSchema,
  contentPlanTopicTurnsQuerySchema,
  type ContentPlanReadServicePort,
} from "./contracts/index.js";

export type ContentPlanningRouteDependencies = WorkspaceSessionDependencies
  & Pick<AppDependencies, "accountAccessService" | "logger">;

const parseRequest = <T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  message: string,
): z.infer<T> => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw badRequest(message, parsed.error.flatten());
};

const TOPIC_NOT_FOUND = "Content plan topic not found";

export const createContentPlanningRoutes = (
  dependencies: ContentPlanningRouteDependencies,
  service: ContentPlanReadServicePort,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const qualityRead = requireWorkspacePermission(dependencies, "workspace.quality.read");

  router.use(workspaceSession, qualityRead);

  router.get("/", async (req, res, next) => {
    try {
      const query = parseRequest(
        contentPlanListQuerySchema,
        req.query,
        "Invalid content plan query",
      );
      const { workspaceId } = res.locals as { workspaceId: string };
      res.status(200).json(await service.list(workspaceId, query));
    } catch (error) {
      next(error);
    }
  });

  router.get("/topics/:topicId/turns", async (req, res, next) => {
    try {
      const { topicId } = parseRequest(
        contentPlanTopicDetailParamsSchema,
        req.params,
        "Invalid content plan topic",
      );
      const query = parseRequest(
        contentPlanTopicTurnsQuerySchema,
        req.query,
        "Invalid content plan topic turns query",
      );
      const { workspaceId } = res.locals as { workspaceId: string };
      const page = await service.listTopicTurns(workspaceId, topicId, query);
      if (!page) throw notFound(TOPIC_NOT_FOUND);
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  router.get("/topics/:topicId", async (req, res, next) => {
    try {
      const { topicId } = parseRequest(
        contentPlanTopicDetailParamsSchema,
        req.params,
        "Invalid content plan topic",
      );
      const { workspaceId } = res.locals as { workspaceId: string };
      const detail = await service.getTopic(workspaceId, topicId);
      if (!detail) throw notFound(TOPIC_NOT_FOUND);
      res.status(200).json(detail);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
