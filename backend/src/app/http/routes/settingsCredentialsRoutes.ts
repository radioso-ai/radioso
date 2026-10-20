import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { VOICE_VENDORS } from "../../../shared/domain/voiceVendor.js";
import { OPENAI_DATA_RESIDENCIES, type LlmProviderName } from "../../../shared/infra/llm/providerTypes.js";

const modelProviderNames = ["openai", "openai-compatible", "gemini", "claude"] as const satisfies readonly LlmProviderName[];
/** Model providers, then voice vendors: one workspace credential store holds both kinds of key. */
export const providerNames = [...modelProviderNames, ...VOICE_VENDORS] as const;
type ProviderNameInput = (typeof providerNames)[number];

/**
 * `apiKey` and `residency` are each optional so that changing an OpenAI credential's residency
 * alone — without re-entering the key — reaches the service through this same request shape;
 * the refine below requires at least one. `residency` only applies to the `openai` provider;
 * `WorkspaceProviderCredentialsService` rejects it for any other provider, since this schema
 * validates the body shape only and has no path param to compare against yet.
 */
export const setProviderCredentialSchema = z.object({
  apiKey: z.string().min(1).max(4096).optional(),
  residency: z.enum(OPENAI_DATA_RESIDENCIES).optional(),
}).refine((input) => input.apiKey !== undefined || input.residency !== undefined, {
  message: "apiKey or residency is required",
});

type CredentialsRouteDependencies = WorkspaceSessionDependencies &
  Pick<AppDependencies, "workspaceProviderCredentialsService" | "accountAccessService" | "env">;

/** Model providers only: a voice vendor key is always the workspace's own, with no deployment fallback. */
const computeEnvProviderAvailability = (
  env: AppDependencies["env"],
): Record<(typeof modelProviderNames)[number], boolean> => ({
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
          residency: entry.residency,
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
        const { apiKey, residency } = req.body as { apiKey?: string; residency?: (typeof OPENAI_DATA_RESIDENCIES)[number] };
        if (apiKey !== undefined) {
          await dependencies.workspaceProviderCredentialsService.setApiKey({
            workspaceId,
            provider,
            apiKey,
            residency,
            actor: { accountId },
          });
        } else {
          // The refine on setProviderCredentialSchema guarantees residency is set here.
          await dependencies.workspaceProviderCredentialsService.setResidency({
            workspaceId,
            provider,
            residency: residency!,
            actor: { accountId },
          });
        }
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
