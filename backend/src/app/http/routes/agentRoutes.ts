import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireSurfaceExtension } from "../shared/requireSurfaceExtension.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import {
  agentSurfacePositions,
  authoredDirectiveInputSchema,
  directiveAuthorDraftInputSchema,
} from "../../../modules/agents/public.js";
import {
  routineDefinitionDraftInputSchema,
  routineDraftAssistRequestSchema,
} from "../../../modules/routines/public.js";
import { builtInAnswerDirectiveViews } from "../../../modules/directives/public.js";
import {
  ASSISTANT_LOGO_MIME_TYPES,
  assistantThemeSchema,
  createAssistantLogoUploadHandler,
} from "../shared/assistantIdentity.js";
import { resolvePublicLaunchLifecycle } from "../../../modules/accessGrants/public.js";
import type { AccessGrant, AccessGrantSecret } from "../../../modules/accessGrants/domain.js";

const agentParamsSchema = z.object({
  agentId: z.string().uuid(),
});

const agentMcpConverseGrantParamsSchema = z.object({
  agentId: z.string().uuid(),
  grantId: z.string().uuid(),
});

const agentDirectiveParamsSchema = z.object({
  agentId: z.string().uuid(),
  directiveId: z.string().uuid(),
});

const agentRoutineParamsSchema = z.object({
  agentId: z.string().uuid(),
  routineId: z.string().uuid(),
});

const authoredDirectiveBodySchema = authoredDirectiveInputSchema.omit({ routes: true });
const authoredDirectivePatchBodySchema = authoredDirectiveBodySchema.partial().strict();
const routineDefinitionBodySchema = routineDefinitionDraftInputSchema;

const surfaceSettingsSchema = z.object({
  authenticatedChat: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  anonymousChat: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
  websiteEmbed: z.object({
    enabled: z.boolean().optional(),
    allowedOrigins: z.array(z.string().max(200)).max(20).optional(),
    launcherLabel: z.string().max(80).optional(),
    launcherPosition: z.enum(agentSurfacePositions).optional(),
    theme: assistantThemeSchema.optional(),
    copy: z.record(z.record(z.string().max(500))).optional(),
    expertOverrides: z.record(z.string().max(500)).optional(),
  }).optional(),
}).optional();

const sourceScopeSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("all"),
  }),
  z.object({
    mode: z.literal("selected"),
    sourceIds: z.array(z.string().uuid()).max(200),
  }),
]).optional();

const brandingSchema = z.object({
  hidePoweredBy: z.boolean().optional(),
  privacyPolicyUrl: z.string().max(2048).nullable().optional(),
}).optional();

const llmProviderNames = ["openai", "openai-compatible", "gemini", "claude"] as const;

const chatModelOverrideSchema = z.union([
  z.null(),
  z.object({
    provider: z.enum(llmProviderNames),
    model: z.string().min(1).max(200),
  }),
]);

const contactRequestDeliverySchema = z.object({
  recipientEmails: z.array(z.string().max(320)).max(5).optional(),
  webhook: z.union([
    z.null(),
    z.object({
      url: z.string().max(2048),
    }),
  ]).optional(),
}).optional();

const mcpConverseGrantIssueBodySchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
}).strict();

export const agentBodySchema = z.object({
  name: z.string().max(200).optional(),
  internalName: z.string().max(200).optional(),
  customInstruction: z.string().max(2000).optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  assistantLinkUtmEnabled: z.boolean().optional(),
  citationDisplayEnabled: z.boolean().optional(),
  contactRequestsEnabled: z.boolean().optional(),
  webhookExportsEnabled: z.boolean().optional(),
  contactRequestDelivery: contactRequestDeliverySchema,
  theme: assistantThemeSchema.optional(),
  branding: brandingSchema,
  retrievalEnabled: z.boolean().optional(),
  sourceScope: sourceScopeSchema,
  greetingInstruction: z.string().max(200).optional(),
  assistantDefaultLocale: z.string().max(35).nullable().optional(),
  proactiveGreetingEnabled: z.boolean().optional(),
  chatModelOverride: chatModelOverrideSchema.optional(),
  skillSettings: z.record(z.unknown()).optional(),
  surfaceSettings: surfaceSettingsSchema,
});

export { llmProviderNames as agentLlmProviderNames, chatModelOverrideSchema as agentChatModelOverrideSchema };

type AgentRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "accountAccessService" | "accessGrantService" | "agentRepository" | "agentService" | "authoredDirectiveService" | "directiveAuthorService" | "skillAuthoringCatalog" | "routineDefinitionService" | "routineDraftAssistService" | "agentSurfaceExtensions" | "documentStorage" | "logger" | "metricsRegistry">;

const presentMcpConverseGrantMetadata = (grant: AccessGrant) => ({
  id: grant.id,
  label: grant.label,
  tokenPrefix: grant.tokenPrefix,
  enabled: grant.enabled,
  createdAt: grant.createdAt.toISOString(),
  lastUsedAt: grant.lastUsedAt ? grant.lastUsedAt.toISOString() : null,
  revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
});

const presentMcpConverseGrantSecret = ({ grant, token }: AccessGrantSecret) => ({
  grant: {
    id: grant.id,
    label: grant.label,
    tokenPrefix: grant.tokenPrefix,
    createdAt: grant.createdAt.toISOString(),
  },
  token,
});

const assertAgentExists = async (
  dependencies: Pick<AgentRouteDependencies, "agentRepository">,
  workspaceId: string,
  agentId: string,
) => {
  const agent = await dependencies.agentRepository.findByIdAndWorkspaceId(agentId, workspaceId);
  if (!agent) {
    throw notFound("Agent not found");
  }
};

const resolveMcpConverseGrantForAgent = async (
  dependencies: Pick<AgentRouteDependencies, "accessGrantService">,
  workspaceId: string,
  agentId: string,
  grantId: string,
): Promise<AccessGrant> => {
  const grant = await dependencies.accessGrantService.findGrantById(grantId);
  if (
    !grant ||
    grant.workspaceId !== workspaceId ||
    grant.agentId !== agentId ||
    grant.principalKind !== "public-launch" ||
    grant.channel !== "mcp-converse"
  ) {
    throw notFound("MCP converse grant not found");
  }
  return grant;
};

export const createAgentRoutes = (dependencies: AgentRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");
  const runUploadSingle = createAssistantLogoUploadHandler();

  router.get("/", workspaceSession, agentRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      res.status(200).json({ agents: await dependencies.agentService.list(workspaceId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", workspaceSession, agentManage, validateBody(agentBodySchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const agent = await dependencies.agentService.create(workspaceId, req.body);
      res.status(201).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const agent = await dependencies.agentService.get(workspaceId, parsed.agentId);
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId/channels/lifecycle", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const agent = await dependencies.agentRepository.findByIdAndWorkspaceId(parsed.agentId, workspaceId);
      if (!agent) {
        throw notFound("Agent not found");
      }

      const [anonymousChat, websiteEmbed] = await Promise.all([
        resolvePublicLaunchLifecycle(agent.surfaceSettings.anonymousChat.token, dependencies.accessGrantService),
        resolvePublicLaunchLifecycle(agent.surfaceSettings.websiteEmbed.token, dependencies.accessGrantService),
      ]);

      res.status(200).json({ anonymousChat, websiteEmbed });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/mcp-converse-grants",
    workspaceSession,
    agentManage,
    validateBody(mcpConverseGrantIssueBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
        const parsed = agentParamsSchema.parse(req.params);
        await assertAgentExists(dependencies, workspaceId, parsed.agentId);
        const secret = await dependencies.accessGrantService.issueGrant({
          agentId: parsed.agentId,
          workspaceId,
          accountId,
          principalKind: "public-launch",
          channel: "mcp-converse",
          originConstraint: { mode: "allow-all", origins: [] },
          label: req.body.label,
        });
        res.status(201).json(presentMcpConverseGrantSecret(secret));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:agentId/mcp-converse-grants", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      await assertAgentExists(dependencies, workspaceId, parsed.agentId);
      const grants = (await dependencies.accessGrantService.listAgentGrants(parsed.agentId))
        .filter((grant) =>
          grant.workspaceId === workspaceId &&
          grant.agentId === parsed.agentId &&
          grant.principalKind === "public-launch" &&
          grant.channel === "mcp-converse"
        )
        .map(presentMcpConverseGrantMetadata);
      res.status(200).json({ grants });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/mcp-converse-grants/:grantId/rotate", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      const parsed = agentMcpConverseGrantParamsSchema.parse(req.params);
      await assertAgentExists(dependencies, workspaceId, parsed.agentId);
      await resolveMcpConverseGrantForAgent(dependencies, workspaceId, parsed.agentId, parsed.grantId);
      const secret = await dependencies.accessGrantService.rotateGrant({
        grantId: parsed.grantId,
        accountId,
        reason: "mcp_converse_grant_rotate",
      });
      res.status(200).json(presentMcpConverseGrantSecret(secret));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:agentId/mcp-converse-grants/:grantId", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId?: string };
      const parsed = agentMcpConverseGrantParamsSchema.parse(req.params);
      await assertAgentExists(dependencies, workspaceId, parsed.agentId);
      await resolveMcpConverseGrantForAgent(dependencies, workspaceId, parsed.agentId, parsed.grantId);
      await dependencies.accessGrantService.revokeGrant({
        grantId: parsed.grantId,
        accountId,
        reason: "mcp_converse_grant_revoke",
      });
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId/directives", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const directives = await dependencies.authoredDirectiveService.list(workspaceId, parsed.agentId);
      res.status(200).json({ directives, builtIns: builtInAnswerDirectiveViews });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/directives/draft",
    workspaceSession,
    agentManage,
    validateBody(directiveAuthorDraftInputSchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const parsed = agentParamsSchema.parse(req.params);
        const result = await dependencies.directiveAuthorService.draft(workspaceId, parsed.agentId, req.body);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:agentId/directives",
    workspaceSession,
    agentManage,
    validateBody(authoredDirectiveBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const parsed = agentParamsSchema.parse(req.params);
        const result = await dependencies.authoredDirectiveService.create(workspaceId, parsed.agentId, req.body);
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:agentId/directives/:directiveId",
    workspaceSession,
    agentManage,
    validateBody(authoredDirectivePatchBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const parsed = agentDirectiveParamsSchema.parse(req.params);
        const result = await dependencies.authoredDirectiveService.update(
          workspaceId,
          parsed.agentId,
          parsed.directiveId,
          req.body,
        );
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/:agentId/directives/:directiveId", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentDirectiveParamsSchema.parse(req.params);
      await dependencies.authoredDirectiveService.delete(workspaceId, parsed.agentId, parsed.directiveId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId/routine-skill-catalog", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId, accountId, userId } = res.locals as {
        workspaceId: string;
        accountId?: string;
        userId?: string;
      };
      const parsed = agentParamsSchema.parse(req.params);
      const agent = await dependencies.agentRepository.findByIdAndWorkspaceId(parsed.agentId, workspaceId);
      if (!agent) {
        throw notFound("Agent not found");
      }
      const skills = await dependencies.skillAuthoringCatalog.listForAgent({
        workspaceId,
        agentId: parsed.agentId,
        ...(accountId ? { accountId } : {}),
        ...(userId ? { userId } : {}),
      });
      res.status(200).json({ skills });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId/routines", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const routines = await dependencies.routineDefinitionService.list(workspaceId, parsed.agentId);
      res.status(200).json({ routines });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:agentId/routines/:routineId", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentRoutineParamsSchema.parse(req.params);
      const routine = await dependencies.routineDefinitionService.get(workspaceId, parsed.agentId, parsed.routineId);
      res.status(200).json({ routine });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/routines/draft-assist",
    workspaceSession,
    agentManage,
    validateBody(routineDraftAssistRequestSchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const parsed = agentParamsSchema.parse(req.params);
        const result = await dependencies.routineDraftAssistService.draft(workspaceId, parsed.agentId, req.body);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:agentId/routines",
    workspaceSession,
    agentManage,
    validateBody(routineDefinitionBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const parsed = agentParamsSchema.parse(req.params);
        const result = await dependencies.routineDefinitionService.createDraft(workspaceId, parsed.agentId, req.body);
        res.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:agentId/routines/:routineId",
    workspaceSession,
    agentManage,
    validateBody(routineDefinitionBodySchema),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const parsed = agentRoutineParamsSchema.parse(req.params);
        const result = await dependencies.routineDefinitionService.updateDraft(
          workspaceId,
          parsed.agentId,
          parsed.routineId,
          req.body,
        );
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/:agentId/routines/:routineId/validate", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentRoutineParamsSchema.parse(req.params);
      const validation = await dependencies.routineDefinitionService.validate(
        workspaceId,
        parsed.agentId,
        { id: parsed.routineId },
      );
      res.status(200).json({ validation });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/routines/:routineId/publish", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentRoutineParamsSchema.parse(req.params);
      const result = await dependencies.routineDefinitionService.publish(workspaceId, parsed.agentId, parsed.routineId);
      if ("rejected" in result) {
        res.status(422).json({
          error: "Routine definition is invalid",
          validation: result.validation,
        });
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/routines/:routineId/revise", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentRoutineParamsSchema.parse(req.params);
      const routine = await dependencies.routineDefinitionService.revise(workspaceId, parsed.agentId, parsed.routineId);
      res.status(200).json({ routine });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/routines/:routineId/archive", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentRoutineParamsSchema.parse(req.params);
      const routine = await dependencies.routineDefinitionService.archive(workspaceId, parsed.agentId, parsed.routineId);
      res.status(200).json({ routine });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/routines/:routineId/restore", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentRoutineParamsSchema.parse(req.params);
      const result = await dependencies.routineDefinitionService.restore(workspaceId, parsed.agentId, parsed.routineId);
      if ("rejected" in result) {
        res.status(422).json({
          error: "Routine definition is invalid",
          validation: result.validation,
        });
        return;
      }
      res.status(200).json({ routine: result.routine });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:agentId/routines/:routineId", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentRoutineParamsSchema.parse(req.params);
      await dependencies.routineDefinitionService.deleteDraft(workspaceId, parsed.agentId, parsed.routineId);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.put("/:agentId", workspaceSession, agentManage, validateBody(agentBodySchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      const agent = await dependencies.agentService.update(
        workspaceId,
        parsed.agentId,
        dependencies.agentService.withRotatedTokens(current, req.body),
      );
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/assistant-logo", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      await runUploadSingle(req, res);
      if (!req.file) {
        throw badRequest("Logo file is required");
      }
      if (!ASSISTANT_LOGO_MIME_TYPES.has(req.file.mimetype)) {
        throw badRequest("Assistant logo must be a PNG, JPEG, WebP, or GIF image");
      }

      const stored = await dependencies.documentStorage.upload({
        workspaceId,
        documentId: `assistant-logo-${parsed.agentId}-${randomUUID()}`,
        filename: req.file.originalname || "assistant-logo",
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
      });
      const uploadedLogo = {
        bucket: stored.bucket,
        objectPath: stored.objectPath,
        generation: stored.generation ?? null,
        mimeType: req.file.mimetype,
        filename: req.file.originalname || "assistant-logo",
        sizeBytes: stored.sizeBytes,
      };
      const agent = await dependencies.agentService.update(workspaceId, parsed.agentId, {
        logo: uploadedLogo,
      }).catch(async (error: unknown) => {
        await dependencies.documentStorage.delete({
          bucket: uploadedLogo.bucket,
          objectPath: uploadedLogo.objectPath,
          generation: uploadedLogo.generation,
        }).catch((cleanupError: unknown) => {
          dependencies.logger.warn({ err: cleanupError, workspaceId, agentId: parsed.agentId }, "Failed to clean up orphaned assistant logo upload");
        });
        throw error;
      });
      const previousLogo = current.logo;
      if (previousLogo) {
        await dependencies.documentStorage.delete({
          bucket: previousLogo.bucket,
          objectPath: previousLogo.objectPath,
          generation: previousLogo.generation ?? null,
        }).catch((error: unknown) => {
          dependencies.logger.warn({ err: error, workspaceId, agentId: parsed.agentId }, "Failed to delete replaced assistant logo");
        });
      }
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:agentId/assistant-logo", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      const agent = await dependencies.agentService.update(workspaceId, parsed.agentId, {
        logo: null,
      });
      const previousLogo = current.logo;
      if (previousLogo) {
        await dependencies.documentStorage.delete({
          bucket: previousLogo.bucket,
          objectPath: previousLogo.objectPath,
          generation: previousLogo.generation ?? null,
        }).catch((error: unknown) => {
          dependencies.logger.warn({ err: error, workspaceId, agentId: parsed.agentId }, "Failed to delete removed assistant logo");
        });
      }
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/anonymous-chat-token/rotate", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      const agent = await dependencies.agentService.update(
        workspaceId,
        parsed.agentId,
        dependencies.agentService.withRotatedTokens(current, { rotateAnonymousChatToken: true }),
      );
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/website-embed-token/rotate", requireSurfaceExtension(dependencies.agentSurfaceExtensions, "websiteEmbed"), workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      const agent = await dependencies.agentService.update(
        workspaceId,
        parsed.agentId,
        dependencies.agentService.withRotatedTokens(current, { rotateWebsiteEmbedToken: true }),
      );
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    "/:agentId",
    workspaceSession,
    requireWorkspacePermission(dependencies, "workspace.agents.delete", (_req, res) => String(res.locals.workspaceId ?? "")),
    async (req, res, next) => {
      try {
        const { workspaceId } = res.locals as { workspaceId: string };
        const parsed = agentParamsSchema.parse(req.params);
        await dependencies.agentService.delete(workspaceId, parsed.agentId);
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/:agentId/default", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const agent = await dependencies.agentService.setDefault(workspaceId, parsed.agentId);
      res.status(200).json(agent);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
