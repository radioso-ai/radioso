import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { notFound } from "../../../shared/domain/errors.js";
import { requireApiToken } from "../middleware/requireApiToken.js";

export const supportedMcpTools = [
  "answer_grounded",
  "create_document",
  "delete_document",
  "describe_capabilities",
  "get_document",
  "get_retrieval_settings",
  "list_documents",
  "reprocess_document",
  "search_documents",
  "update_document",
  "update_retrieval_settings",
] as const;

export const workspaceMcpContextSchema = z.object({
  apiVersion: z.literal("0.1.0"),
  mcpContextVersion: z.literal("2026-04-22"),
  supportedTools: z.array(z.enum(supportedMcpTools)),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1),
});

export const createMcpContextRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/context", requireApiToken(dependencies), async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const workspace = await dependencies.workspaceRepository.findById(workspaceId);
      if (!workspace) {
        throw notFound("Workspace not found");
      }

      res.status(200).json({
        apiVersion: "0.1.0",
        mcpContextVersion: "2026-04-22",
        supportedTools: [...supportedMcpTools],
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
