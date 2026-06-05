import { z } from "zod";
import { publicChatSessionSchema } from "../../routes/publicChatRouteSchemas.js";
import { agentSurfacePositions, authoredDirectiveCriticalities } from "../../../../modules/agents/public.js";
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

  const AgentContactRequestDeliverySchema = registry.register(
    "AgentContactRequestDelivery",
    z.object({
      recipientEmails: z.array(z.string()).max(5),
      webhook: z.object({
        url: z.string(),
      }).nullable(),
    }),
  );

  const AgentContactRequestDeliveryRequestSchema = registry.register(
    "AgentContactRequestDeliveryRequest",
    z.object({
      recipientEmails: z.array(z.string().max(320)).max(5).optional(),
      webhook: z.union([
        z.null(),
        z.object({
          url: z.string().max(2048),
        }),
      ]).optional(),
    }),
  );

  const ConversationAgentSchema = registry.register(
    "ConversationAgent",
    AgentSchema.extend({
      isDefault: z.boolean(),
      customInstruction: z.string(),
      suggestedQuestionsEnabled: z.boolean(),
      assistantLinkUtmEnabled: z.boolean(),
      citationDisplayEnabled: z.boolean(),
      contactRequestsEnabled: z.boolean(),
      contactRequestDelivery: AgentContactRequestDeliverySchema,
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
      skillSettings: z.record(z.unknown()),
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
      assistantLinkUtmEnabled: z.boolean().optional(),
      citationDisplayEnabled: z.boolean().optional(),
      contactRequestsEnabled: z.boolean().optional(),
      contactRequestDelivery: AgentContactRequestDeliveryRequestSchema.optional(),
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
      skillSettings: z.record(z.unknown()).optional(),
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

  const AuthoredDirectiveParamsSchema = z.object({
    agentId: z.string().uuid(),
    directiveId: z.string().uuid(),
  });

  const AuthoredDirectiveConditionSchema = registry.register(
    "AuthoredDirectiveCondition",
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("always"),
      }),
      z.object({
        kind: z.literal("contextual"),
        description: z.string().min(1).max(2000),
      }),
    ]),
  );

  const AuthoredDirectiveRequestBaseSchema = z.object({
    name: z.string().min(1).max(200),
    condition: AuthoredDirectiveConditionSchema,
    action: z.string().min(1).max(4000),
    priority: z.number().int().nullable().optional(),
    criticality: z.enum(authoredDirectiveCriticalities).nullable().optional(),
    requiredCapabilities: z.array(z.string().min(1).max(200)).optional(),
    dependsOn: z.array(z.string().min(1).max(200)).optional(),
    excludes: z.array(z.string().min(1).max(200)).optional(),
    description: z.string().min(1).max(1000).nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  }).strict();

  const AuthoredDirectiveCreateRequestSchema = registry.register(
    "AuthoredDirectiveCreateRequest",
    AuthoredDirectiveRequestBaseSchema,
  );

  const AuthoredDirectiveUpdateRequestSchema = registry.register(
    "AuthoredDirectiveUpdateRequest",
    AuthoredDirectiveRequestBaseSchema.partial().strict(),
  );

  const AuthoredDirectiveResponseSchema = registry.register(
    "AuthoredDirective",
    z.object({
      id: z.string().uuid(),
      agentId: z.string().uuid(),
      name: z.string(),
      condition: AuthoredDirectiveConditionSchema,
      action: z.string(),
      priority: z.number().int().nullable(),
      criticality: z.enum(authoredDirectiveCriticalities).nullable(),
      requiredCapabilities: z.array(z.string()),
      dependsOn: z.array(z.string()),
      excludes: z.array(z.string()),
      routes: z.array(z.string()),
      description: z.string().nullable(),
      metadata: z.record(z.unknown()),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const DirectiveCoherenceVerdictSchema = registry.register(
    "DirectiveCoherenceVerdict",
    z.object({
      coherent: z.boolean(),
      conflicts: z.array(z.object({
        directiveId: z.string().optional(),
        directiveName: z.string(),
        reason: z.string(),
      })),
      rationale: z.string(),
    }),
  );

  const AuthoredDirectiveListResponseSchema = registry.register(
    "AuthoredDirectiveListResponse",
    z.object({
      directives: z.array(AuthoredDirectiveResponseSchema),
    }),
  );

  const AuthoredDirectiveSaveResponseSchema = registry.register(
    "AuthoredDirectiveSaveResponse",
    z.object({
      directive: AuthoredDirectiveResponseSchema,
      coherence: DirectiveCoherenceVerdictSchema,
    }),
  );

  const PublicChatSessionResponseSchema = registry.register(
    "PublicChatSessionResponse",
    z.object({
      agentId: z.string().uuid().optional(),
      agentName: z.string().optional(),
      assistantLinkUtmEnabled: z.boolean(),
      workspaceName: z.string(),
      publicChatToken: z.string(),
      publicSessionId: z.string().uuid(),
      publicSessionToken: z.string(),
      resumeToken: z.string(),
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
      resumeExpiresAt: z.string().datetime(),
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
    AgentContactRequestDeliverySchema,
    AgentContactRequestDeliveryRequestSchema,
    ConversationAgentSurfaceSettingsSchema,
    AgentSourceScopeSchema,
    ConversationAgentSchema,
    AgentListResponseSchema,
    ConversationAgentRequestSchema,
    AgentParamsSchema,
    AuthoredDirectiveConditionSchema,
    AuthoredDirectiveCreateRequestSchema,
    AuthoredDirectiveListResponseSchema,
    AuthoredDirectiveParamsSchema,
    AuthoredDirectiveResponseSchema,
    AuthoredDirectiveSaveResponseSchema,
    AuthoredDirectiveUpdateRequestSchema,
    DirectiveCoherenceVerdictSchema,
    PublicChatSessionResponseSchema,
    PublicChatSessionRequestSchema,
    WorkspaceIngestionReprocessResponseSchema,
  });
};
