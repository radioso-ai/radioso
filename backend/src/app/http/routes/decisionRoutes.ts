import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { AppError, badRequest } from "../../../shared/domain/errors.js";
import { ApprovalDecisionServiceError } from "../../../modules/approvals/public.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";

type DecisionRouteDependencies = WorkspaceSessionDependencies & Pick<
  AppDependencies,
  "accountAccessService" | "approvalDecisionService"
>;

const decisionParamsSchema = z.object({
  agentId: z.string().trim().min(1),
  handle: z.string().trim().min(1),
});

const resolveDecisionBodySchema = z.object({
  optionId: z.string().trim().min(1),
  payload: z.unknown().optional(),
  contentHash: z.string().trim().min(1),
}).strict();

const parseParams = (params: unknown): z.infer<typeof decisionParamsSchema> => {
  const parsed = decisionParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw badRequest("Invalid request params", parsed.error.flatten());
  }
  return parsed.data;
};

const toHttpError = (error: ApprovalDecisionServiceError): AppError => {
  switch (error.reason) {
    case "not_found":
      return new AppError(404, "not_found", "Decision not found");
    case "already_resolved":
      return new AppError(409, "already_resolved", "Decision is already resolved");
    case "forbidden_decider":
      return new AppError(403, "forbidden_decider", "Caller cannot resolve this decision");
    case "stale_proposal":
      return new AppError(409, "stale_proposal", "Decision proposal is stale");
    case "invalid_option":
    case "unknown_outcome":
      return new AppError(422, "invalid_option", "Decision option is invalid");
    case "concurrent_resolution":
      return new AppError(409, "concurrent_resolution", "Decision was resolved concurrently");
  }
};

export const createDecisionRoutes = (dependencies: DecisionRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const decisionPermission = requireWorkspacePermission(dependencies, "workspace.conversation.takeover");

  router.post(
    "/:agentId/decisions/:handle/resolve",
    workspaceSession,
    decisionPermission,
    validateBody(resolveDecisionBodySchema),
    async (req, res, next) => {
      try {
        const { accountId, userId, workspaceId, authPrincipal } = res.locals as {
          accountId: string;
          userId?: string;
          workspaceId: string;
          authPrincipal?: { type: string; role?: "admin" | "member" | "public"; userId?: string };
        };
        const params = parseParams(req.params);
        const body = req.body as z.infer<typeof resolveDecisionBodySchema>;
        const result = await dependencies.approvalDecisionService.resolve({
          agentId: params.agentId,
          handle: params.handle,
          optionId: body.optionId,
          payload: body.payload,
          contentHash: body.contentHash,
          caller: { accountId, userId, workspaceId, principal: authPrincipal },
        });

        res.status(200).json(result);
      } catch (error) {
        if (error instanceof ApprovalDecisionServiceError) {
          next(toHttpError(error));
          return;
        }
        next(error);
      }
    },
  );

  return router;
};
