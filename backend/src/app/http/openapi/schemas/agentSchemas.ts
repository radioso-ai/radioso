import { z } from "zod";
import { publicChatSessionSchema } from "../../routes/publicChatRouteSchemas.js";
import { agentSurfacePositions } from "../../../../modules/agents/public.js";
import { skillDisplayMetadataSchema } from "../../../../modules/skills/public.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerAgentSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const AgentSchema = registry.register(
    "Agent",
    z.object({
      id: z.string().uuid(),
      workspaceId: z.string().uuid(),
      name: z.string(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const ConversationAgentSurfaceSettingsSchema = registry.register(
    "ConversationAgentSurfaceSettings",
    z.object({
      authenticatedChat: z.object({
        enabled: z.boolean(),
      }),
      anonymousChat: z.object({
        enabled: z.boolean(),
        token: z.string().nullable(),
      }),
      websiteEmbed: z.object({
        enabled: z.boolean(),
        token: z.string().nullable(),
        allowedOrigins: z.array(z.string()),
        launcherLabel: z.string(),
        launcherPosition: z.enum(agentSurfacePositions),
        theme: z.object({
          brand: z.string(),
          brandText: z.string(),
          surface: z.string(),
          text: z.string(),
        }),
        copy: z.record(z.record(z.string())),
        expertOverrides: z.record(z.string()),
      }),
    }),
  );

  const AgentSourceScopeSchema = registry.register(
    "AgentSourceScope",
    z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("all"),
      }),
      z.object({
        mode: z.literal("selected"),
        sourceIds: z.array(z.string().uuid()).max(200),
      }),
    ]),
  );

  const ConversationAgentSchema = registry.register(
    "ConversationAgent",
    AgentSchema.extend({
      isDefault: z.boolean(),
      customInstruction: z.string(),
      suggestedQuestionsEnabled: z.boolean(),
      theme: z.object({
        brand: z.string(),
        brandText: z.string(),
        surface: z.string(),
        text: z.string(),
      }),
      branding: z.object({
        hidePoweredBy: z.boolean(),
        privacyPolicyUrl: z.string().nullable(),
      }),
      retrievalEnabled: z.boolean(),
      sourceScope: AgentSourceScopeSchema,
      logo: schemas.AgentLogoSchema,
      greetingInstruction: z.string(),
      assistantDefaultLocale: z.string().nullable(),
      proactiveGreetingEnabled: z.boolean(),
      assistantBootstrapActive: z.boolean(),
      chatModelOverride: z.object({
        provider: z.enum(["openai", "openai-compatible", "gemini", "claude"]),
        model: z.string(),
      }).nullable(),
      surfaceSettings: ConversationAgentSurfaceSettingsSchema,
    }),
  );

  const AgentListResponseSchema = registry.register(
    "AgentListResponse",
    z.object({
      agents: z.array(ConversationAgentSchema),
    }),
  );

  const ConversationAgentRequestSchema = registry.register(
    "ConversationAgentRequest",
    z.object({
      name: z.string().max(200).optional(),
      customInstruction: z.string().max(2000).optional(),
      suggestedQuestionsEnabled: z.boolean().optional(),
      theme: z.object({
        brand: z.string().optional(),
        brandText: z.string().optional(),
        surface: z.string().optional(),
        text: z.string().optional(),
      }).optional(),
      branding: z.object({
        hidePoweredBy: z.boolean().optional(),
        privacyPolicyUrl: z.string().max(2048).nullable().optional(),
      }).optional(),
      retrievalEnabled: z.boolean().optional(),
      sourceScope: z.discriminatedUnion("mode", [
        z.object({
          mode: z.literal("all"),
        }),
        z.object({
          mode: z.literal("selected"),
          sourceIds: z.array(z.string().uuid()).max(200),
        }),
      ]).optional(),
      greetingInstruction: z.string().max(200).optional(),
      assistantDefaultLocale: z.string().max(35).nullable().optional(),
      proactiveGreetingEnabled: z.boolean().optional(),
      chatModelOverride: z.union([
        z.null(),
        z.object({
          provider: z.enum(["openai", "openai-compatible", "gemini", "claude"]),
          model: z.string().min(1).max(200),
        }),
      ]).optional(),
      surfaceSettings: z.object({
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
          theme: z.object({
            brand: z.string().optional(),
            brandText: z.string().optional(),
            surface: z.string().optional(),
            text: z.string().optional(),
          }).optional(),
          copy: z.record(z.record(z.string())).optional(),
          expertOverrides: z.record(z.string()).optional(),
        }).optional(),
      }).optional(),
    }),
  );

  const AgentParamsSchema = z.object({
    agentId: z.string().uuid(),
  });

  const PublicChatSessionResponseSchema = registry.register(
    "PublicChatSessionResponse",
    z.object({
      agentId: z.string().uuid().optional(),
      agentName: z.string().optional(),
      workspaceName: z.string(),
      publicChatToken: z.string(),
      publicSessionId: z.string().uuid(),
      publicSessionToken: z.string(),
      assistantBootstrapActive: z.boolean(),
      assistantAvatarUrl: z.string().nullable().optional(),
      theme: z.object({
        brand: z.string(),
        brandText: z.string(),
        surface: z.string(),
        text: z.string(),
      }).optional(),
      branding: z.object({
        hidePoweredBy: z.boolean(),
        privacyPolicyUrl: z.string().nullable(),
      }).optional(),
      intakeActions: z.array(z.object({
        skillName: z.string(),
        intentName: z.string(),
        display: skillDisplayMetadataSchema.optional(),
      })).optional(),
      expiresAt: z.string().datetime(),
    }),
  );

  const PublicChatSessionRequestSchema = registry.register(
    "PublicChatSessionRequest",
    publicChatSessionSchema,
  );

  const WorkspaceIngestionReprocessResponseSchema = registry.register(
    "WorkspaceIngestionReprocessResponse",
    z.object({
      workspaceId: z.string().uuid(),
      queuedDocumentCount: z.number().int().min(0),
      skippedDocumentCount: z.number().int().min(0),
      status: z.enum(["queued", "noop"]),
    }),
  );

  Object.assign(schemas, {
    AgentSchema,
    ConversationAgentSurfaceSettingsSchema,
    AgentSourceScopeSchema,
    ConversationAgentSchema,
    AgentListResponseSchema,
    ConversationAgentRequestSchema,
    AgentParamsSchema,
    PublicChatSessionResponseSchema,
    PublicChatSessionRequestSchema,
    WorkspaceIngestionReprocessResponseSchema,
  });
};
