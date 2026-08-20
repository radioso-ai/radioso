import { Router } from "express";
import { z } from "zod";

import { requireSession, type SessionDependencies } from "../../app/http/middleware/requireSession.js";
import { badRequest } from "../../shared/domain/errors.js";
import type { UsageDetailsServicePort, UsageTrendsServicePort } from "./contracts/index.js";
import { createUsageDetailsRoutes } from "./usageDetailsRoutes.js";

const usageTrendsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  granularity: z.enum(["day", "week", "month"]),
  workspaceId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
});

export type UsageTrendsRouteDependencies = SessionDependencies;

const parseQuery = (value: unknown): z.infer<typeof usageTrendsQuerySchema> => {
  const parsed = usageTrendsQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest("Invalid usage trends query", parsed.error.flatten());
  }
  return parsed.data;
};

export const createUsageTrendsRoutes = (
  dependencies: UsageTrendsRouteDependencies,
  service: UsageTrendsServicePort,
): Router => {
  const router = Router();
  const authenticatedSession = requireSession(dependencies);

  router.get("/usage-trends", authenticatedSession, async (req, res, next) => {
    try {
      const query = parseQuery(req.query);
      const { accountId, userId } = res.locals as { accountId: string; userId: string };
      const response = await service.getUsageTrends({
        accountId,
        userId,
        from: query.from,
        to: query.to,
        granularity: query.granularity,
        workspaceId: query.workspaceId,
        agentId: query.agentId,
      });
      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  });

  return router;
};

export const createUsageReportingRoutes = (
  dependencies: UsageTrendsRouteDependencies,
  trendsService: UsageTrendsServicePort,
  detailsService: UsageDetailsServicePort,
): Router => {
  const router = Router();
  router.use(createUsageTrendsRoutes(dependencies, trendsService));
  router.use(createUsageDetailsRoutes(dependencies, detailsService));
  return router;
};
