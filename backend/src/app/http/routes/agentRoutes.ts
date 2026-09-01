import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { requireSurfaceExtension } from "../shared/requireSurfaceExtension.js";
import { validateBody } from "../middleware/validate.js";
import { requireApiAccessCsrf } from "../middleware/requireApiAccessCsrf.js";
import { requireRestAgentChannelCredential, type AgentChannelCredentialLocals } from "../middleware/requireAgentChannelCredential.js";
import { agentChannelChatRateLimiters, createAgentChannelSourceRateLimiter } from "../middleware/agentChannelRateLimiter.js";
import { onSuccessfulHttpResponse } from "../middleware/httpResponseCompletion.js";
import { sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import {
  agentChannelChatSchema,
  agentChannelCredentialIssueSchema,
  agentChannelCredentialListQuerySchema,
  agentChannelCredentialParamsSchema,
} from "../schemas/agentChannelSchemas.js";
import { AppError, badRequest, forbidden, notFound } from "../../../shared/domain/errors.js";
import {
  agentSurfacePositions,
  authoredDirectiveInputSchema,
  directiveAuthorDraftInputSchema,
} from "../../../modules/agents/public.js";
import {
  routineDefinitionDraftInputSchema,
  routineDraftAssistRequestSchema,
} from "../../../modules/routines/public.js";
import type { AgentInput, AgentSettingsResource } from "../../../modules/agents/public.js";
import { builtInAnswerDirectiveViews } from "../../../modules/directives/public.js";
import {
  ASSISTANT_LOGO_MIME_TYPES,
  assistantThemeSchema,
  createAssistantLogoUploadHandler,
} from "../shared/assistantIdentity.js";
import { resolvePublicLaunchLifecycle } from "../../../modules/accessGrants/public.js";
import type { AccessGrant, AccessGrantSecret } from "../../../modules/accessGrants/domain.js";
import type { AccessGrantLifecycleActor } from "../../../modules/accessGrants/services/accessGrantService.js";

const agentParamsSchema = z.object({
  agentId: z.string().uuid(),
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

type AgentRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "accountAccessService" | "accessGrantService" | "agentRepository" | "agentService" | "assistantChatService" | "authoredDirectiveService" | "directiveAuthorService" | "skillAuthoringCatalog" | "routineDefinitionService" | "routineDraftAssistService" | "agentSurfaceExtensions" | "documentStorage" | "logger" | "metricsRegistry" | "abuseControlService" | "auditService">;

const channelForAudience = (audience: "mcp" | "rest") =>
  audience === "mcp" ? "mcp-converse" as const : "agent-api" as const;

const audienceForChannel = (channel: AccessGrant["channel"]): "mcp" | "rest" | null => {
  if (channel === "mcp-converse") return "mcp";
  if (channel === "agent-api") return "rest";
  return null;
};

const encodeCredentialCursor = (cursor: { createdAt: string; id: string }): string =>
  Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");

const decodeCredentialCursor = (value: string | undefined): { createdAt: string; id: string } | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string" || !parsed.id || !z.string().uuid().safeParse(parsed.id).success) throw new Error("invalid cursor");
    if (!/^\d{4}-\d{2}-\d{2}(?:T| )\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(parsed.createdAt)) throw new Error("invalid cursor");
    const createdAt = new Date(parsed.createdAt);
    if (!Number.isFinite(createdAt.getTime())) throw new Error("invalid cursor");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw badRequest("Invalid credential pagination cursor");
  }
};

const presentAgentChannelCredential = (grant: AccessGrant) => {
  if (!grant.expiresAt) {
    throw new AppError(500, "internal_error", "Agent-channel credential is missing its required expiry.");
  }

  return {
    id: grant.id,
    audience: audienceForChannel(grant.channel),
    label: grant.label,
    prefix: grant.tokenPrefix,
    status: grant.revokedAt
      ? "revoked"
      : !grant.enabled
        ? "disabled"
        : grant.expiresAt.getTime() <= Date.now()
          ? "expired"
          : "active",
    createdAt: grant.createdAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
    lastUsedAt: grant.lastUsedAt ? grant.lastUsedAt.toISOString() : null,
    revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
  };
};

const presentAgentChannelCredentialSecret = ({ grant, token }: AccessGrantSecret) => ({
  credential: presentAgentChannelCredential(grant),
  secret: token,
});

type AgentRoutePrincipal = {
  type?: string;
} | null | undefined;

const isMachinePrincipal = (principal: AgentRoutePrincipal): boolean =>
  principal?.type === "personal_api_credential" || principal?.type === "service_account_credential";

const lifecycleActor = (locals: {
  userId?: string;
  authPrincipal?: AgentRoutePrincipal;
}): AccessGrantLifecycleActor | null => {
  if (locals.userId) return { kind: "user", id: locals.userId };
  if (locals.authPrincipal?.type === "personal_api_credential" && typeof (locals.authPrincipal as { userId?: unknown }).userId === "string") {
    return { kind: "user", id: (locals.authPrincipal as { userId: string }).userId };
  }
  if (locals.authPrincipal?.type === "service_account_credential" && typeof (locals.authPrincipal as { serviceAccountId?: unknown }).serviceAccountId === "string") {
    return { kind: "service", id: (locals.authPrincipal as { serviceAccountId: string }).serviceAccountId };
  }
  return null;
};

/**
 * Machine credentials may author ordinary agent configuration, but public-launch
 * credentials are interactive-only. Keep the resource shape useful while making
 * the launch secrets unavailable to bearer clients.
 */
const presentAgentForPrincipal = (agent: AgentSettingsResource, principal: AgentRoutePrincipal) => {
  if (!isMachinePrincipal(principal)) return agent;
  const { token: _anonymousChatToken, ...anonymousChat } = agent.surfaceSettings.anonymousChat;
  const { token: _websiteEmbedToken, ...websiteEmbed } = agent.surfaceSettings.websiteEmbed;
  const extensions = agent.surfaceSettings.extensions;
  const extensionWebsiteEmbed = extensions?.websiteEmbed;
  const safeExtensions = extensionWebsiteEmbed && typeof extensionWebsiteEmbed === "object" && !Array.isArray(extensionWebsiteEmbed)
    ? {
      ...extensions,
      websiteEmbed: (() => {
        const { token: _token, ...safeWebsiteEmbed } = extensionWebsiteEmbed as Record<string, unknown>;
        return safeWebsiteEmbed;
      })(),
    }
    : extensions;
  return {
    ...agent,
    surfaceSettings: {
      ...agent.surfaceSettings,
      anonymousChat,
      websiteEmbed,
      ...(safeExtensions ? { extensions: safeExtensions } : {}),
    },
  };
};

const rejectMachineLaunchSurfaceInput = (principal: AgentRoutePrincipal, input: AgentInput): void => {
  if (!isMachinePrincipal(principal)) return;
  if (input.surfaceSettings?.anonymousChat !== undefined || input.surfaceSettings?.websiteEmbed !== undefined) {
    throw forbidden("Public launch surfaces require an interactive session");
  }
};

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

const resolveAgentChannelCredential = async (
  dependencies: Pick<AgentRouteDependencies, "accessGrantService">,
  workspaceId: string,
  agentId: string,
  credentialId: string,
): Promise<AccessGrant> => {
  const grant = await dependencies.accessGrantService.findGrantById(credentialId);
  if (
    !grant ||
    grant.workspaceId !== workspaceId ||
    grant.agentId !== agentId ||
    grant.principalKind !== "agent-api" ||
    audienceForChannel(grant.channel) === null
  ) {
    throw notFound("Agent channel credential not found");
  }
  return grant;
};

export const createAgentRoutes = (dependencies: AgentRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const agentRead = requireWorkspacePermission(dependencies, "workspace.agents.read");
  const agentManage = requireWorkspacePermission(dependencies, "workspace.agents.manage");
  const runUploadSingle = createAssistantLogoUploadHandler();
  const rateLimitRestAgentChat = agentChannelChatRateLimiters(dependencies, "rest");
  const rateLimitRestAgentSource = createAgentChannelSourceRateLimiter(dependencies);

  router.get("/", workspaceSession, agentRead, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { authPrincipal } = res.locals as { authPrincipal?: AgentRoutePrincipal };
      const agents = await dependencies.agentService.list(workspaceId);
      res.status(200).json({ agents: agents.map((agent) => presentAgentForPrincipal(agent, authPrincipal)) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", workspaceSession, agentManage, validateBody(agentBodySchema), async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { authPrincipal } = res.locals as { authPrincipal?: AgentRoutePrincipal };
      rejectMachineLaunchSurfaceInput(authPrincipal, req.body);
      const agent = await dependencies.agentService.create(workspaceId, req.body);
      res.status(201).json(presentAgentForPrincipal(agent, authPrincipal));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:agentId/chat",
    rateLimitRestAgentSource,
    validateBody(agentChannelChatSchema),
    requireRestAgentChannelCredential(dependencies),
    ...rateLimitRestAgentChat,
    async (req, res, next) => {
      try {
        const { agentChannelGrant } = res.locals as typeof res.locals & AgentChannelCredentialLocals;
        const chatInput = {
          workspaceId: agentChannelGrant.workspaceId,
          agentId: agentChannelGrant.agentId,
          accountId: undefined,
          conversationId: req.body.conversationId,
          message: req.body.message,
          startConversation: req.body.startConversation,
          stream: req.body.stream,
          userExpectedLocale: req.body.userExpectedLocale,
          sourceChannel: "agent_api",
          sourceOrigin: null,
        };
        if (req.body.stream) {
          onSuccessfulHttpResponse(res, () => dependencies.accessGrantService.recordAgentChannelChatSucceeded({
            grant: agentChannelGrant,
          }));
          await sendChatSse(res, dependencies.assistantChatService.streamAnswer(chatInput));
          return;
        }
        const response = await dependencies.assistantChatService.answer(chatInput);
        onSuccessfulHttpResponse(res, () => dependencies.accessGrantService.recordAgentChannelChatSucceeded({
          grant: agentChannelGrant,
        }));
        if (!response) {
          res.status(204).end();
          return;
        }
        sendChatJson(res, response);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:agentId", workspaceSession, agentRead, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const { authPrincipal } = res.locals as { authPrincipal?: AgentRoutePrincipal };
      const parsed = agentParamsSchema.parse(req.params);
      const agent = await dependencies.agentService.get(workspaceId, parsed.agentId);
      res.status(200).json(presentAgentForPrincipal(agent, authPrincipal));
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
    "/:agentId/channel-credentials",
    workspaceSession,
    requireApiAccessCsrf,
    agentManage,
    validateBody(agentChannelCredentialIssueSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, accountId, userId, authPrincipal } = res.locals as { workspaceId: string; accountId?: string; userId?: string; authPrincipal?: AgentRoutePrincipal };
        const parsed = agentParamsSchema.parse(req.params);
        await assertAgentExists(dependencies, workspaceId, parsed.agentId);
        const secret = await dependencies.accessGrantService.issueGrant({
          agentId: parsed.agentId,
          workspaceId,
          accountId,
          actor: lifecycleActor({ userId, authPrincipal }),
          principalKind: "agent-api",
          channel: channelForAudience(req.body.audience),
          originConstraint: { mode: "allow-all", origins: [] },
          label: req.body.label,
          expiresAt: req.body.expiresAt,
        });
        res.status(201).json(presentAgentChannelCredentialSecret(secret));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:agentId/channel-credentials", workspaceSession, agentManage, async (req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      const parsed = agentParamsSchema.parse(req.params);
      const query = agentChannelCredentialListQuerySchema.parse(req.query);
      await assertAgentExists(dependencies, workspaceId, parsed.agentId);
      const page = await dependencies.accessGrantService.listAgentGrants(parsed.agentId, {
        workspaceId,
        principalKind: "agent-api",
        channel: query.audience ? channelForAudience(query.audience) : undefined,
        limit: query.limit,
        cursor: decodeCredentialCursor(query.cursor),
      });
      const credentials = page.grants.map(presentAgentChannelCredential);
      res.status(200).json({ credentials, nextCursor: page.nextCursor ? encodeCredentialCursor(page.nextCursor) : null });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/channel-credentials/:credentialId/rotate", workspaceSession, requireApiAccessCsrf, agentManage, async (req, res, next) => {
    try {
      const { workspaceId, accountId, userId, authPrincipal } = res.locals as { workspaceId: string; accountId?: string; userId?: string; authPrincipal?: AgentRoutePrincipal };
      const parsed = agentChannelCredentialParamsSchema.parse(req.params);
      await assertAgentExists(dependencies, workspaceId, parsed.agentId);
      await resolveAgentChannelCredential(dependencies, workspaceId, parsed.agentId, parsed.credentialId);
      const secret = await dependencies.accessGrantService.rotateGrant({
        grantId: parsed.credentialId,
        accountId,
        actor: lifecycleActor({ userId, authPrincipal }),
        reason: "agent_channel_credential_rotate",
      });
      res.status(200).json(presentAgentChannelCredentialSecret(secret));
    } catch (error) {
      next(error);
    }
  });

  router.post("/:agentId/channel-credentials/:credentialId/revoke", workspaceSession, requireApiAccessCsrf, agentManage, async (req, res, next) => {
    try {
      const { workspaceId, accountId, userId, authPrincipal } = res.locals as { workspaceId: string; accountId?: string; userId?: string; authPrincipal?: AgentRoutePrincipal };
      const parsed = agentChannelCredentialParamsSchema.parse(req.params);
      await assertAgentExists(dependencies, workspaceId, parsed.agentId);
      await resolveAgentChannelCredential(dependencies, workspaceId, parsed.agentId, parsed.credentialId);
      await dependencies.accessGrantService.revokeGrant({
        grantId: parsed.credentialId,
        accountId,
        actor: lifecycleActor({ userId, authPrincipal }),
        reason: "agent_channel_credential_revoke",
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

  router.post("/:agentId/routines/:routineId/validate", workspaceSession, agentRead, async (req, res, next) => {
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
      const { authPrincipal } = res.locals as { authPrincipal?: AgentRoutePrincipal };
      const parsed = agentParamsSchema.parse(req.params);
      const current = await dependencies.agentService.resolve(workspaceId, parsed.agentId);
      rejectMachineLaunchSurfaceInput(authPrincipal, req.body);
      const agent = await dependencies.agentService.update(
        workspaceId,
        parsed.agentId,
        dependencies.agentService.withRotatedTokens(current, req.body),
      );
      res.status(200).json(presentAgentForPrincipal(agent, authPrincipal));
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
