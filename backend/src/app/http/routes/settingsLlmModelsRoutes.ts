import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";
import {
  workspaceLlmCapabilities,
  type WorkspaceLlmCapability,
} from "../../../modules/settings/contracts/llmCapability.js";
import { knownModelsByProvider } from "../../../shared/infra/llm/knownModels.js";

export const workspaceLlmProviderNames = ["openai", "openai-compatible", "gemini", "claude"] as const;

const preferenceSchema = z.object({
  provider: z.enum(workspaceLlmProviderNames),
  model: z.string().min(1).max(200),
});

const capabilityFieldSchema = z.union([preferenceSchema, z.null()]).optional();

export const updateWorkspaceLlmModelsSchema = z.object({
  chat: capabilityFieldSchema,
  rewrite: capabilityFieldSchema,
  rerank: capabilityFieldSchema,
});

type SettingsLlmRouteDependencies = WorkspaceSessionDependencies &
  Pick<AppDependencies, "workspaceLlmCapabilitySettingsService" | "accountAccessService">;

export const createSettingsLlmModelsRoutes = (
  dependencies: SettingsLlmRouteDependencies,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read");
  const modelsManage = requireWorkspacePermission(dependencies, "workspace.llm-models.manage");

  router.get("/", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const preferences = await dependencies.workspaceLlmCapabilitySettingsService.listForWorkspace(workspaceId);
      const indexed = Object.fromEntries(
        preferences.map((entry) => [entry.capability, { provider: entry.provider, model: entry.model }]),
      ) as Record<WorkspaceLlmCapability, { provider: string; model: string }>;
      res.status(200).json({
        chat: indexed.chat ?? null,
        rewrite: indexed.rewrite ?? null,
        rerank: indexed.rerank ?? null,
        knownModelsByProvider: {
          openai: [...knownModelsByProvider.openai],
          "openai-compatible": [...knownModelsByProvider["openai-compatible"]],
          gemini: [...knownModelsByProvider.gemini],
          claude: [...knownModelsByProvider.claude],
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/",
    workspaceSession,
    modelsManage,
    validateBody(updateWorkspaceLlmModelsSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
        const updates = req.body as z.infer<typeof updateWorkspaceLlmModelsSchema>;
        const actor = { accountId };

        for (const capability of workspaceLlmCapabilities) {
          if (!(capability in updates)) {
            continue;
          }
          const value = updates[capability];
          if (value === null) {
            await dependencies.workspaceLlmCapabilitySettingsService.removePreference(
              workspaceId,
              capability,
              actor,
            );
          } else if (value !== undefined) {
            await dependencies.workspaceLlmCapabilitySettingsService.setPreference(
              workspaceId,
              capability,
              value,
              actor,
            );
          }
        }

        const preferences = await dependencies.workspaceLlmCapabilitySettingsService.listForWorkspace(workspaceId);
        const indexed = Object.fromEntries(
          preferences.map((entry) => [entry.capability, { provider: entry.provider, model: entry.model }]),
        ) as Record<WorkspaceLlmCapability, { provider: string; model: string }>;
        res.status(200).json({
          chat: indexed.chat ?? null,
          rewrite: indexed.rewrite ?? null,
          rerank: indexed.rerank ?? null,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          next(badRequest(error.message));
          return;
        }
        next(error);
      }
    },
  );

  return router;
};
