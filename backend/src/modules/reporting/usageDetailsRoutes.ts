import { Router } from "express";
import { z } from "zod";

import { requireSession, type SessionDependencies } from "../../app/http/middleware/requireSession.js";
import { badRequest } from "../../shared/domain/errors.js";
import type { UsageDetailsServicePort } from "./contracts/index.js";
import {
  DEFAULT_USAGE_DETAILS_LIMIT,
  MAX_USAGE_DETAILS_LIMIT,
} from "./usageDetailsQuery.js";

export const usageDetailsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  workspaceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_USAGE_DETAILS_LIMIT).optional().default(DEFAULT_USAGE_DETAILS_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
});

export type UsageDetailsRouteDependencies = SessionDependencies;

const parseQuery = (value: unknown): z.infer<typeof usageDetailsQuerySchema> => {
  const parsed = usageDetailsQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest("Invalid detailed usage query", parsed.error.flatten());
  }
  return parsed.data;
};

export const createUsageDetailsRoutes = (
  dependencies: UsageDetailsRouteDependencies,
  service: UsageDetailsServicePort,
): Router => {
  const router = Router();
  const authenticatedSession = requireSession(dependencies);

  router.get("/usage/messages", authenticatedSession, async (req, res, next) => {
    try {
      const query = parseQuery(req.query);
      const { accountId, userId } = res.locals as { accountId: string; userId: string };
      const response = await service.getMessageUsage({
        accountId,
        userId,
        from: query.from,
        to: query.to,
        workspaceId: query.workspaceId,
        limit: query.limit,
        cursor: query.cursor,
      });
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get("/usage/internal-operations", authenticatedSession, async (req, res, next) => {
    try {
      const query = parseQuery(req.query);
      const { accountId, userId } = res.locals as { accountId: string; userId: string };
      const response = await service.getInternalUsage({
        accountId,
        userId,
        from: query.from,
        to: query.to,
        workspaceId: query.workspaceId,
        limit: query.limit,
        cursor: query.cursor,
      });
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
