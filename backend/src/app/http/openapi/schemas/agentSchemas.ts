import { z } from "zod";
import { publicChatSessionSchema } from "../../routes/publicChatRouteSchemas.js";
import { agentSurfacePositions, authoredDirectiveSurfaceValues } from "../../../../modules/agents/public.js";
import {
  routineDefinitionDraftInputSchema,
  routineDraftAssistRequestSchema,
  routineDefinitionStatuses,
  routineValidationCodes,
} from "../../../../modules/routines/public.js";
import { skillDisplayMetadataSchema, skillOutcomeStatusSchema } from "../../../../modules/skills/public.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerAgentSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const AgentSchema = registry.register(
    "Agent",
    z.object({
      id: z.string().uuid(),
      workspaceId: z.string().uuid(),
      name: z.string(),
      internalName: z.string(),
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
      webhookExportsEnabled: z.boolean(),
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
      internalName: z.string().max(200).optional(),
      customInstruction: z.string().max(2000).optional(),
      suggestedQuestionsEnabled: z.boolean().optional(),
      assistantLinkUtmEnabled: z.boolean().optional(),
      citationDisplayEnabled: z.boolean().optional(),
      contactRequestsEnabled: z.boolean().optional(),
      webhookExportsEnabled: z.boolean().optional(),
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

  const AgentChannelLifecycleSchema = registry.register(
    "AgentChannelLifecycle",
    z.object({
      lastUsedAt: z.string().datetime().nullable(),
    }),
  );

  const AgentChannelsLifecycleResponseSchema = registry.register(
    "AgentChannelsLifecycleResponse",
    z.object({
      anonymousChat: AgentChannelLifecycleSchema,
      websiteEmbed: AgentChannelLifecycleSchema,
    }),
  );

  const AgentMcpConverseGrantMetadataSchema = registry.register(
    "AgentMcpConverseGrantMetadata",
    z.object({
      id: z.string().uuid(),
      label: z.string().nullable(),
      tokenPrefix: z.string(),
      enabled: z.boolean(),
      createdAt: z.string().datetime(),
      lastUsedAt: z.string().datetime().nullable(),
      revokedAt: z.string().datetime().nullable(),
    }),
  );

  const AgentMcpConverseGrantSecretSchema = registry.register(
    "AgentMcpConverseGrantSecret",
    z.object({
      id: z.string().uuid(),
      label: z.string().nullable(),
      tokenPrefix: z.string(),
      createdAt: z.string().datetime(),
    }),
  );

  const AgentMcpConverseGrantIssueRequestSchema = registry.register(
    "AgentMcpConverseGrantIssueRequest",
    z.object({
      label: z.string().min(1).max(120).optional(),
    }),
  );

  const AgentMcpConverseGrantIssueResponseSchema = registry.register(
    "AgentMcpConverseGrantIssueResponse",
    z.object({
      grant: AgentMcpConverseGrantSecretSchema,
      token: z.string(),
    }),
  );

  const AgentMcpConverseGrantSecretResponseSchema = registry.register(
    "AgentMcpConverseGrantSecretResponse",
    z.object({
      grant: AgentMcpConverseGrantSecretSchema,
      token: z.string(),
    }),
  );

  const AgentMcpConverseGrantListResponseSchema = registry.register(
    "AgentMcpConverseGrantListResponse",
    z.object({
      grants: z.array(AgentMcpConverseGrantMetadataSchema),
    }),
  );

  const AgentMcpConverseGrantParamsSchema = z.object({
    agentId: z.string().uuid(),
    grantId: z.string().uuid(),
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

  const AuthoredDirectiveBindingSchema = registry.register(
    "AuthoredDirectiveBinding",
    z.object({
      kind: z.literal("skill"),
      skillName: z.string().min(1).max(200),
    }).strict(),
  );

  const AuthoredDirectiveLifecycleSchema = registry.register(
    "AuthoredDirectiveLifecycle",
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("repeatable") }).strict(),
      z.object({ kind: z.literal("once_per_conversation") }).strict(),
      z.object({ kind: z.literal("cooldown"), turns: z.number().int().min(1).max(1000) }).strict(),
    ]),
  );

  const GenerationSurfaceSchema = registry.register(
    "GenerationSurface",
    z.enum(authoredDirectiveSurfaceValues).openapi({
      description:
        "Generator a directive addresses. Omitted or empty means the answer body only.",
    }),
  );

  const AuthoredDirectiveRequestBaseSchema = z.object({
    name: z.string().min(1).max(200),
    condition: AuthoredDirectiveConditionSchema,
    action: z.string().min(1).max(4000),
    priority: z.number().int().min(0).max(100).nullable().optional(),
    requiredCapabilities: z.array(z.string().min(1).max(200)).optional(),
    dependsOn: z.array(z.string().min(1).max(200)).optional(),
    excludes: z.array(z.string().min(1).max(200)).optional(),
    surfaces: z.array(GenerationSurfaceSchema).optional(),
    tags: z.array(z.string().min(1).max(200)).optional(),
    description: z.string().min(1).max(1000).nullable().optional(),
    binding: z.union([AuthoredDirectiveBindingSchema, z.null()]).optional(),
    lifecycle: z.union([AuthoredDirectiveLifecycleSchema, z.null()]).optional(),
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

  const DirectiveDraftRequestSchema = registry.register(
    "DirectiveDraftRequest",
    z.object({
      coachingText: z.string().min(1).max(20_000),
      turn: z.object({
        userMessage: z.string().min(1).max(20_000),
        assistantAnswer: z.string().min(1).max(40_000),
        activeRoutineId: z.string().min(1).max(200).optional(),
        activeStepId: z.string().min(1).max(200).optional(),
      }).strict(),
    }).strict(),
  );

  const DirectiveDraftDirectiveSchema = registry.register(
    "DirectiveDraftDirective",
    z.object({
      name: z.string().min(1).max(200),
      condition: AuthoredDirectiveConditionSchema,
      action: z.string().min(1).max(4000),
      tags: z.array(z.string().min(1).max(200)),
      surfaces: z.array(GenerationSurfaceSchema).optional(),
    }),
  );

  const DirectiveDraftResponseSchema = registry.register(
    "DirectiveDraftResponse",
    z.object({
      directive: DirectiveDraftDirectiveSchema,
      diagnosis: z.enum(["directive_recommended", "knowledge_recommended_deferred"]),
      rationale: z.string().min(1).max(1000).optional(),
    }),
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
      requiredCapabilities: z.array(z.string()),
      dependsOn: z.array(z.string()),
      excludes: z.array(z.string()),
      routes: z.array(z.string()),
      surfaces: z.array(GenerationSurfaceSchema),
      tags: z.array(z.string()),
      description: z.string().nullable(),
      binding: z.union([AuthoredDirectiveBindingSchema, z.null()]),
      lifecycle: z.union([AuthoredDirectiveLifecycleSchema, z.null()]),
      metadata: z.record(z.unknown()),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const BuiltInDirectiveSchema = registry.register(
    "BuiltInDirective",
    z.object({
      name: z.string(),
      condition: AuthoredDirectiveConditionSchema,
      action: z.string(),
      priority: z.number().int().nullable(),
      description: z.string().nullable(),
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

  const DirectiveListResponseSchema = registry.register(
    "DirectiveListResponse",
    z.object({
      directives: z.array(AuthoredDirectiveResponseSchema),
      builtIns: z.array(BuiltInDirectiveSchema),
    }),
  );
  const AuthoredDirectiveListResponseSchema = DirectiveListResponseSchema;

  const AuthoredDirectiveSaveResponseSchema = registry.register(
    "AuthoredDirectiveSaveResponse",
    z.object({
      directive: AuthoredDirectiveResponseSchema,
      coherence: DirectiveCoherenceVerdictSchema,
    }),
  );

  const RoutineDefinitionParamsSchema = z.object({
    agentId: z.string().uuid(),
    routineId: z.string().uuid(),
  });

  const RoutineDefinitionCreateRequestSchema = registry.register(
    "RoutineDefinitionCreateRequest",
    routineDefinitionDraftInputSchema,
  );

  const RoutineDefinitionUpdateRequestSchema = registry.register(
    "RoutineDefinitionUpdateRequest",
    routineDefinitionDraftInputSchema,
  );

  const RoutineDraftAssistRequestSchema = registry.register(
    "RoutineDraftAssistRequest",
    routineDraftAssistRequestSchema,
  );

  const RoutineValidationResultSchema = registry.register(
    "RoutineValidationResult",
    z.object({
      ok: z.boolean(),
      diagnostics: z.array(z.object({
        code: z.enum(routineValidationCodes),
        location: z.string(),
        message: z.string(),
      })),
    }),
  );

  const RoutineDefinitionResponseSchema = registry.register(
    "RoutineDefinition",
    routineDefinitionDraftInputSchema.extend({
      id: z.string().uuid(),
      agentId: z.string().uuid(),
      lineageId: z.string().uuid(),
      version: z.number().int().min(1),
      status: z.enum(routineDefinitionStatuses),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );

  const RoutineDefinitionListResponseSchema = registry.register(
    "RoutineDefinitionListResponse",
    z.object({
      routines: z.array(RoutineDefinitionResponseSchema),
    }),
  );

  const RoutineDefinitionGetResponseSchema = registry.register(
    "RoutineDefinitionGetResponse",
    z.object({
      routine: RoutineDefinitionResponseSchema,
    }),
  );

  const RoutineDefinitionSaveResponseSchema = registry.register(
    "RoutineDefinitionSaveResponse",
    z.object({
      routine: RoutineDefinitionResponseSchema,
      validation: RoutineValidationResultSchema,
    }),
  );

  const RoutineDirectiveScopeOrphanSchema = registry.register(
    "RoutineDirectiveScopeOrphan",
    z.object({
      directiveId: z.string(),
      scopeTag: z.string(),
      reason: z.literal("missing_step"),
    }),
  );

  const RoutineDefinitionPublishResponseSchema = registry.register(
    "RoutineDefinitionPublishResponse",
    z.object({
      routine: RoutineDefinitionResponseSchema,
      validation: RoutineValidationResultSchema,
      directiveScopeOrphans: z.array(RoutineDirectiveScopeOrphanSchema),
    }),
  );

  const RoutineDefinitionLifecycleResponseSchema = registry.register(
    "RoutineDefinitionLifecycleResponse",
    z.object({
      routine: RoutineDefinitionResponseSchema,
    }),
  );

  const RoutineDefinitionValidateResponseSchema = registry.register(
    "RoutineDefinitionValidateResponse",
    z.object({
      validation: RoutineValidationResultSchema,
    }),
  );

  const RoutineDraftAssistResponseSchema = registry.register(
    "RoutineDraftAssistResponse",
    z.object({
      draft: routineDefinitionDraftInputSchema,
      validation: RoutineValidationResultSchema,
    }),
  );

  const RoutineDefinitionPublishRejectedResponseSchema = registry.register(
    "RoutineDefinitionPublishRejectedResponse",
    z.object({
      error: z.literal("Routine definition is invalid"),
      validation: RoutineValidationResultSchema,
    }),
  );

  const SkillAuthoringInputSchema = registry.register(
    "SkillAuthoringInput",
    z.object({
      key: z.string(),
      type: z.enum(["text", "number", "boolean", "email", "date", "phone", "enum"]),
      required: z.boolean(),
      description: z.string().optional(),
      enumValues: z.array(z.string()).optional(),
    }),
  );

  const SkillAuthoringOutcomeSchema = registry.register(
    "SkillAuthoringOutcome",
    z.object({
      name: z.string(),
      displayName: z.string(),
      description: z.string().optional(),
      status: skillOutcomeStatusSchema,
    }),
  );

  const SkillAuthoringDescriptorSchema = registry.register(
    "SkillAuthoringDescriptor",
    z.object({
      skillName: z.string(),
      displayName: z.string(),
      category: z.enum(["retrieval", "built_in", "external_mcp", "customer_email", "webhook", "slack", "notify"]),
      description: z.string().optional(),
      inputs: z.array(SkillAuthoringInputSchema),
      outcomes: z.array(SkillAuthoringOutcomeSchema),
      hasDataOutputs: z.boolean(),
    }),
  );

  const RoutineSkillCatalogResponseSchema = registry.register(
    "RoutineSkillCatalogResponse",
    z.object({
      skills: z.array(SkillAuthoringDescriptorSchema),
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
      copy: z.record(z.record(z.string())).optional(),
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
    AgentChannelLifecycleSchema,
    AgentChannelsLifecycleResponseSchema,
    AgentMcpConverseGrantIssueRequestSchema,
    AgentMcpConverseGrantIssueResponseSchema,
    AgentMcpConverseGrantListResponseSchema,
    AgentMcpConverseGrantMetadataSchema,
    AgentMcpConverseGrantParamsSchema,
    AgentMcpConverseGrantSecretResponseSchema,
    AgentParamsSchema,
    AuthoredDirectiveConditionSchema,
    AuthoredDirectiveBindingSchema,
    AuthoredDirectiveCreateRequestSchema,
    AuthoredDirectiveListResponseSchema,
    AuthoredDirectiveParamsSchema,
    AuthoredDirectiveResponseSchema,
    AuthoredDirectiveSaveResponseSchema,
    AuthoredDirectiveUpdateRequestSchema,
    BuiltInDirectiveSchema,
    DirectiveDraftRequestSchema,
    DirectiveDraftResponseSchema,
    DirectiveCoherenceVerdictSchema,
    DirectiveListResponseSchema,
    RoutineDefinitionCreateRequestSchema,
    RoutineDraftAssistRequestSchema,
    RoutineDraftAssistResponseSchema,
    RoutineDefinitionGetResponseSchema,
    RoutineDefinitionListResponseSchema,
    RoutineDefinitionParamsSchema,
    RoutineDefinitionLifecycleResponseSchema,
    RoutineDefinitionPublishResponseSchema,
    RoutineDefinitionPublishRejectedResponseSchema,
    RoutineSkillCatalogResponseSchema,
    RoutineDirectiveScopeOrphanSchema,
    SkillAuthoringDescriptorSchema,
    RoutineDefinitionResponseSchema,
    RoutineDefinitionSaveResponseSchema,
    RoutineDefinitionUpdateRequestSchema,
    RoutineDefinitionValidateResponseSchema,
    RoutineValidationResultSchema,
    PublicChatSessionResponseSchema,
    PublicChatSessionRequestSchema,
    WorkspaceIngestionReprocessResponseSchema,
  });
};
