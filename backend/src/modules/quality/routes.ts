import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../app/server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../../app/http/middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../../app/http/middleware/requirePermission.js";
import { badRequest } from "../../shared/domain/errors.js";
import type { QualityTurnsServicePort } from "./contracts/index.js";

export type QualityRouteDependencies = WorkspaceSessionDependencies
  & Pick<AppDependencies, "accountAccessService">;

const csvOrArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === "string") {
      return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    }
    return value;
  }, z.array(item).optional());

const actionTupleSchema = z
  .string()
  .regex(/^[^:]+:[^:]+$/, "Action filter entries must use the form skillName:outcome")
  .transform((value) => {
    const colonIndex = value.indexOf(":");
    return {
      skillName: value.slice(0, colonIndex),
      outcome: value.slice(colonIndex + 1),
    };
  });

const turnsQuerySchema = z.object({
  actions: csvOrArray(actionTupleSchema),
  statuses: csvOrArray(
    z.enum([
      "active",
      "paused",
      "awaiting_confirmation",
      "awaiting_tool",
      "completed",
      "cancelled",
      "expired",
      "failed",
    ]),
  ),
  feedback: csvOrArray(z.enum(["up", "down"])),
  hasComment: z.preprocess((value) => {
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, z.boolean().optional()),
  agentId: z.string().uuid().optional(),
  channel: z.string().trim().min(1).max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  minTotalLatencyMs: z.coerce.number().int().min(0).optional(),
  maxTotalLatencyMs: z.coerce.number().int().min(0).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const parseRequest = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  throw badRequest("Invalid quality turns query", parsed.error.flatten());
};

export const createQualityRoutes = (
  dependencies: QualityRouteDependencies,
  service: QualityTurnsServicePort,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  // Quality reviewers can see thumbs-down comments authored by end users, so
  // this surface is admin/owner only — `workspace.quality.read` is not in the
  // workspace-member allowlist on AccountAccessService.
  const qualityRead = requireWorkspacePermission(dependencies, "workspace.quality.read");

  router.get("/turns", workspaceSession, qualityRead, async (req, res, next) => {
    try {
      const query = parseRequest(turnsQuerySchema, req.query);
      const { workspaceId } = res.locals as { workspaceId: string };
      const page = await service.listLowQualityTurns(workspaceId, {
        actions: query.actions,
        statuses: query.statuses,
        feedbackValues: query.feedback,
        hasComment: query.hasComment,
        minTotalLatencyMs: query.minTotalLatencyMs,
        maxTotalLatencyMs: query.maxTotalLatencyMs,
        agentId: query.agentId,
        channel: query.channel,
        from: query.from,
        to: query.to,
        offset: query.offset,
        limit: query.limit ?? 25,
      });
      res.status(200).json(page);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
