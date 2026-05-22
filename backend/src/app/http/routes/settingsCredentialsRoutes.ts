import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";

export const providerNames = ["openai", "openai-compatible", "gemini", "claude"] as const;
export type ProviderNameInput = (typeof providerNames)[number];

export const setProviderCredentialSchema = z.object({
  apiKey: z.string().min(1).max(4096),
});

type CredentialsRouteDependencies = WorkspaceSessionDependencies &
  Pick<AppDependencies, "workspaceProviderCredentialsService" | "accountAccessService" | "env">;

const computeEnvProviderAvailability = (
  env: AppDependencies["env"],
): Record<ProviderNameInput, boolean> => ({
  openai: Boolean(env.OPENAI_API_KEY),
  "openai-compatible": Boolean(env.OPENAI_COMPATIBLE_API_KEY ?? env.OPENAI_API_KEY),
  gemini: Boolean(env.GEMINI_API_KEY),
  claude: Boolean(env.ANTHROPIC_API_KEY),
});

export const createSettingsCredentialsRoutes = (
  dependencies: CredentialsRouteDependencies,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const settingsRead = requireWorkspacePermission(dependencies, "workspace.settings.read");
  const credentialsManage = requireWorkspacePermission(dependencies, "workspace.credentials.manage");
  const providerParam = z.enum(providerNames);
  const parseProviderParam = (raw: unknown): ProviderNameInput => {
    const result = providerParam.safeParse(raw);
    if (!result.success) {
      throw badRequest(`Unknown provider: ${String(raw)}`);
    }
    return result.data;
  };

  router.get("/", workspaceSession, settingsRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const configured = await dependencies.workspaceProviderCredentialsService.listConfigured(workspaceId);
      res.status(200).json({
        encryptionConfigured: dependencies.workspaceProviderCredentialsService.isEncryptionConfigured(),
        credentials: configured.map((entry) => ({
          provider: entry.provider,
          updatedAt: entry.updatedAt.toISOString(),
        })),
        envProviderAvailability: computeEnvProviderAvailability(dependencies.env),
      });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    "/:provider",
    workspaceSession,
    credentialsManage,
    validateBody(setProviderCredentialSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
        const provider = parseProviderParam(req.params.provider);
        await dependencies.workspaceProviderCredentialsService.setApiKey({
          workspaceId,
          provider,
          apiKey: req.body.apiKey,
          actor: { accountId },
        });
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/:provider", workspaceSession, credentialsManage, async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      const provider = parseProviderParam(req.params.provider);
      const removed = await dependencies.workspaceProviderCredentialsService.removeApiKey(
        workspaceId,
        provider,
        { accountId },
      );
      if (!removed) {
        next(notFound(`No stored credential for provider "${provider}"`));
        return;
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
