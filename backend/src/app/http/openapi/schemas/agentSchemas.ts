import { z } from "zod";
import { publicChatSessionSchema } from "../../routes/publicChatRouteSchemas.js";
import {
  agentChannelChatSchema,
  agentChannelCredentialIssueSchema,
  agentChannelCredentialLabelSchema,
  agentChannelCredentialListQuerySchema,
  agentChannelCredentialParamsSchema,
} from "../../schemas/agentChannelSchemas.js";
import {
  AGENT_CONFIG_SCHEMA_VERSION,
  agentSurfacePositions,
  authoredDirectiveRouteValues,
  authoredDirectiveSurfaceValues,
} from "../../../../modules/agents/public.js";
import type { AgentConfig } from "../../../../modules/agents/public.js";
import {
  routineDefinitionDraftInputSchema,
  routineDraftAssistRequestSchema,
  routineDefinitionStatuses,
  routineValidationCodes,
} from "../../../../modules/routines/public.js";
import { skillDisplayMetadataSchema, skillOutcomeStatusSchema } from "../../../../modules/skills/public.js";
import { AGENT_BUNDLE_SCHEMA_VERSION } from "../../../../modules/agentBundle/public.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

// Bundle collections are name-keyed, not id-keyed: see `agentBundle/domain.ts`
// for why. The enums below mirror the route-level validation in
// `agentBundleRoutes.ts` rather than importing zod schemas cross-module.
const AgentConfigPortabilityValueSchema = z.enum(["portable", "ref", "secret"]);
const AgentBundleContextVariableSourceSchema = z.enum(["pushed", "browser", "resolver"]);
const AgentBundleContextVariableSurfacingSchema = z.enum(["always", "on_reference", "operator_only"]);
const AgentBundleSkillInvocationModeSchema = z.enum(["default_answer", "routine_named", "agent_selectable"]);

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

  const AgentChannelCredentialMetadataSchema = registry.register(
    "AgentChannelCredentialMetadata",
    z.object({
      id: z.string().uuid(),
      audience: z.enum(["mcp", "rest"]),
      label: agentChannelCredentialLabelSchema,
      prefix: z.string(),
      status: z.enum(["active", "expired", "revoked", "disabled"]),
      createdAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      lastUsedAt: z.string().datetime().nullable(),
      revokedAt: z.string().datetime().nullable(),
    }),
  );

  const AgentChannelCredentialIssueRequestSchema = registry.register(
    "AgentChannelCredentialIssueRequest",
    agentChannelCredentialIssueSchema,
  );

  const AgentChannelCredentialIssueResponseSchema = registry.register(
    "AgentChannelCredentialIssueResponse",
    z.object({
      credential: AgentChannelCredentialMetadataSchema,
      secret: z.string(),
    }),
  );

  const AgentChannelCredentialListResponseSchema = registry.register(
    "AgentChannelCredentialListResponse",
    z.object({
      credentials: z.array(AgentChannelCredentialMetadataSchema),
      nextCursor: z.string().nullable(),
    }),
  );

  const AgentChannelChatRequestSchema = registry.register(
    "AgentChannelChatRequest",
    agentChannelChatSchema,
  );

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
    enabled: z.boolean().optional().openapi({
      description: "Reversible off switch. A disabled directive keeps its authored text but never reaches the matcher. Defaults to true.",
    }),
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
      enabled: z.boolean(),
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

  const AgentConfigRefPlaceholderSchema = registry.register(
    "AgentConfigRefPlaceholder",
    z.object({
      __ref: z.enum([
        "documentSource",
        "storageBucket",
        "storageObjectPath",
        "storageGeneration",
        "websiteEmbedAllowedOrigin",
        "mcpConnection",
        "agentSkillTarget",
      ]),
      key: z.string().optional(),
    }).openapi({
      description:
        "A workspace-scoped reference that does not travel between workspaces (for example a credential-bearing "
        + "connection). The bundle carries only the kind so the caller can see what did not come along; `key` "
        + "links the placeholder back to another entity exported in the same bundle when re-binding on import is possible.",
    }),
  );

  const AgentConfigSecretPlaceholderSchema = registry.register(
    "AgentConfigSecretPlaceholder",
    z.object({ __redacted: z.literal("secret") }).openapi({
      description: "Stands in for a credential the export withholds. Only its absence travels, never the value.",
    }),
  );

  /**
   * `z.union([Schema, z.null()])` rather than `Schema.nullable()` wherever the inner
   * schema is registered. `.nullable()` on a `$ref` emits `allOf: [$ref, {type:
   * [..., "null"]}]`, which openapi-typescript renders as `Ref & (Record<string,
   * never> | null)` — a type nothing satisfies, so an SDK consumer cannot construct
   * the field at all. This is the convention the rest of this file already follows.
   */
  const AgentBundleLogoSchema = z.object({
    bucket: AgentConfigRefPlaceholderSchema,
    objectPath: AgentConfigRefPlaceholderSchema,
    generation: z.union([AgentConfigRefPlaceholderSchema, z.null()]),
    mimeType: z.string(),
    filename: z.string(),
    sizeBytes: z.number().int(),
  });

  const AgentBundleThemeSchema = z.object({
    brand: z.string(),
    brandText: z.string(),
    surface: z.string(),
    text: z.string(),
  });

  const AgentBundleSourceScopeSchema = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("all") }),
    z.object({
      mode: z.literal("selected"),
      sourceIds: z.array(AgentConfigRefPlaceholderSchema).openapi({
        description: "Placeheld: document source ids exist in one workspace only. Import starts with none selected.",
      }),
    }),
  ]);

  const AgentBundleWebsiteEmbedSchema = z.object({
    enabled: z.boolean(),
    token: z.union([AgentConfigSecretPlaceholderSchema, z.null()]),
    allowedOrigins: z.array(AgentConfigRefPlaceholderSchema),
    launcherLabel: z.string(),
    launcherPosition: z.enum(agentSurfacePositions),
    theme: AgentBundleThemeSchema,
    copy: z.record(z.record(z.string())),
    expertOverrides: z.record(z.string()),
  });

  const AgentBundleAuthoredDirectiveSchema = registry.register(
    "AgentBundleAuthoredDirective",
    z.object({
      name: z.string(),
      condition: AuthoredDirectiveConditionSchema,
      action: z.string(),
      priority: z.number().int().nullable(),
      requiredCapabilities: z.array(z.string()),
      dependsOn: z.array(z.string()),
      excludes: z.array(z.string()),
      routes: z.array(z.enum(authoredDirectiveRouteValues)),
      surfaces: z.array(GenerationSurfaceSchema),
      tags: z.array(z.string()),
      description: z.string().nullable(),
      binding: z.union([AuthoredDirectiveBindingSchema, z.null()]),
      lifecycle: z.union([AuthoredDirectiveLifecycleSchema, z.null()]),
      enabled: z.boolean(),
      metadata: z.record(z.unknown()),
    }).openapi({
      description:
        "An authored directive as it travels. Every reference is a name — `binding.skillName`, `dependsOn` and "
        + "`excludes` — so nothing here needs re-keying on import.",
    }),
  );

  const AgentBundleExternalSkillsSchema = registry.register(
    "AgentBundleExternalSkills",
    z.object({
      connections: z.array(z.object({
        key: z.string().openapi({ description: "Within-bundle linkage key, never a database id." }),
        displayName: z.string(),
        serverUrl: z.string(),
        authMethod: z.string(),
        credential: z.union([AgentConfigSecretPlaceholderSchema, z.null()]),
        oauth: z.object({
          authorizationEndpoint: z.string(),
          tokenEndpoint: z.string(),
          clientId: z.string(),
          clientSecret: z.union([AgentConfigSecretPlaceholderSchema, z.null()]),
          scopes: z.array(z.string()),
        }).nullable(),
      })),
      skills: z.array(z.object({
        skillName: z.string(),
        connection: AgentConfigRefPlaceholderSchema,
        toolName: z.string(),
        boundParams: z.record(z.unknown()),
        exposedParams: z.record(z.object({
          description: z.string().optional(),
          slotBinding: z.string().optional(),
        })),
        declaredOutcomes: z.array(z.string()).nullable(),
        outcomeMap: z.record(z.string()).nullable(),
        enabled: z.boolean(),
      })),
    }).openapi({
      description:
        "Exported for completeness. Import does not re-create these: an MCP connection cannot serve until its "
        + "credential is re-entered, so each one comes back in `unresolved` for the operator to rebuild.",
    }),
  );

  /**
   * The real shape, not a placeholder. An SDK consumer has to be able to read an
   * exported agent and construct one to import, and a schema that published only
   * `schemaVersion` made `{ agent: { schemaVersion: 3 } }` look like a valid bundle
   * while silently dropping every behaviour-carrying field.
   */
  const AgentBundleAgentConfigSchema = registry.register(
    "AgentBundleAgentConfig",
    z.object({
      schemaVersion: z.number().int(),
      portability: z.record(z.enum(["portable", "ref", "secret"])).openapi({
        description: "Per-field classification, keyed by field path. `ref` and `secret` fields carry placeholders.",
      }),
      name: z.string(),
      internalName: z.string().nullable(),
      customInstruction: z.string(),
      handoffOnRetrievalMiss: z.boolean(),
      contactRequestsEnabled: z.boolean(),
      webhookExportsEnabled: z.boolean(),
      // Bare reference, no inline `.openapi()`: wrapping a $ref emits
      // `allOf: [$ref, { description }]`, which generates `Ref & unknown`. The
      // explanation lives in this object's own description instead.
      contactRequestDelivery: AgentConfigSecretPlaceholderSchema,
      logo: AgentBundleLogoSchema.nullable().openapi({
        description: "Metadata only. The image lives in object storage and is not part of the bundle.",
      }),
      theme: AgentBundleThemeSchema,
      branding: z.object({
        hidePoweredBy: z.boolean(),
        privacyPolicyUrl: z.string().nullable(),
      }),
      greetingInstruction: z.string(),
      assistantDefaultLocale: z.string().nullable(),
      proactiveGreetingEnabled: z.boolean(),
      surfaceSettings: z.object({
        authenticatedChat: z.object({ enabled: z.boolean() }),
        anonymousChat: z.object({
          enabled: z.boolean(),
          token: z.union([AgentConfigSecretPlaceholderSchema, z.null()]),
        }),
        websiteEmbed: AgentBundleWebsiteEmbedSchema,
        extensions: z.record(z.unknown()).openapi({
          description: "Surface extensions keyed by extension id; shape is owned by the contributing extension.",
        }),
      }),
      skillSettings: z.record(z.unknown()).openapi({
        description:
          "Per-skill settings keyed by skill name. `retrieval.answer` carries an `{ enabled, settings }` envelope "
          + "whose `settings.__agentRetrievalDefaults` holds the agent-level retrieval defaults and source scope.",
      }),
      chatModelOverride: z.object({
        provider: z.string(),
        model: z.string(),
      }).nullable(),
      authoredDirectives: z.array(AgentBundleAuthoredDirectiveSchema),
      externalSkills: AgentBundleExternalSkillsSchema,
    }).openapi({
      description:
        "The agent configuration projection (AgentConfig) at schemaVersion "
        + `${AGENT_CONFIG_SCHEMA_VERSION}. Fields classified \`ref\` or \`secret\` in \`portability\` carry `
        + "placeholders rather than values, so an exported bundle never contains a credential or a workspace-scoped id. "
        + "`contactRequestDelivery` is always redacted: its recipients and webhook stay in the source workspace so an "
        + "imported agent cannot deliver contact requests to another workspace's people, and import reports "
        + "`contact_delivery_unbound` when contact requests are on.",
    }),
  );

  /**
   * Compile-time guard: a field added to `AgentConfig` without being described above
   * fails the build here rather than silently vanishing from the published contract,
   * which is how the placeholder version of this schema went unnoticed.
   */
  type DescribedAgentConfigKeys = keyof z.infer<typeof AgentBundleAgentConfigSchema>;
  type UndescribedAgentConfigKeys = Exclude<keyof AgentConfig, DescribedAgentConfigKeys>;
  const _agentBundleAgentConfigIsExhaustive: [UndescribedAgentConfigKeys] extends [never] ? true : never = true;
  void _agentBundleAgentConfigIsExhaustive;

  const AgentBundleRoutineSchema = registry.register(
    "AgentBundleRoutine",
    z.object({
      name: z.string(),
      version: z.number().int().openapi({ description: "Source version, carried for provenance only; import always creates v1." }),
      definition: routineDefinitionDraftInputSchema,
    }),
  );

  const AgentBundleContextVariableSchema = registry.register(
    "AgentBundleContextVariable",
    z.object({
      variableName: z.string(),
      source: AgentBundleContextVariableSourceSchema,
      resolverSkillName: z.string().nullable(),
      maxAgeSeconds: z.number().int().nullable(),
      resolverTimeoutMs: z.number().int().nullable(),
      surfacing: AgentBundleContextVariableSurfacingSchema,
      enabled: z.boolean(),
    }),
  );

  const AgentBundleSkillSchema = registry.register(
    "AgentBundleSkill",
    z.object({
      name: z.string(),
      capability: z.string(),
      invocationMode: AgentBundleSkillInvocationModeSchema,
      enabled: z.boolean(),
      config: z.record(z.unknown()).openapi({ description: "Only the fields a capability marked portable." }),
      omittedConfigKeys: z.array(z.string()).openapi({
        description: "Settings the source agent had a value for that the capability does not mark portable. Key names only, never values; import reports them so the operator knows what to re-enter.",
      }),
      target: z.object({
        kind: z.string().nullable(),
        id: z.union([AgentConfigRefPlaceholderSchema, z.null()]),
      }).openapi({
        description: "Addresses a workspace connection that holds credentials, so the id is placeheld and the skill imports unbound.",
      }),
    }),
  );

  const AgentBundleUnresolvedKindSchema = registry.register(
    "AgentBundleUnresolvedKind",
    z.enum([
      "context_variable_missing",
      "resolver_skill_missing",
      "skill_target_unbound",
      "skill_capability_unknown",
      "routine_invalid",
      "document_source_unresolved",
      "surface_credential_unbound",
      "mcp_connection_unbound",
      "asset_not_portable",
      "skill_config_not_portable",
      "directive_binding_unbound",
      "contact_delivery_unbound",
    ]).openapi({
      description: [
        "Why a bundle element could not be fully applied to the target workspace. Every element is reported",
        "rather than silently dropped: a bundle that imports quietly minus a skill binding is an agent that",
        "looks configured and answers wrong.",
        "- context_variable_missing: the bundle names a context variable that does not exist in this workspace.",
        "- resolver_skill_missing: the enablement's resolver skill did not survive import, so it stays unbound.",
        "- skill_target_unbound: the skill's connection target is a credential-bearing workspace row.",
        "- skill_capability_unknown: no capability with this id is registered in this deployment.",
        "- routine_invalid: the routine imported as a draft because publish validation rejected it.",
        "- document_source_unresolved: selected document sources cannot be matched; scope imports empty, not \"all\".",
        "- surface_credential_unbound: a surface whose token cannot travel; imported disabled so it cannot serve.",
        "- mcp_connection_unbound: an external MCP connection reference; the skill imports without its server.",
        "- asset_not_portable: binary stored outside the database (the logo); not part of the bundle.",
        "- skill_config_not_portable: a skill setting whose value the capability keeps inside its own workspace.",
        "- directive_binding_unbound: a directive bound to a skill that did not survive import; kept, but disabled.",
        "- contact_delivery_unbound: contact requests are on but their destination stayed in the source workspace.",
      ].join("\n"),
    }),
  );

  const AgentBundleUnresolvedReferenceSchema = registry.register(
    "AgentBundleUnresolvedReference",
    z.object({
      kind: AgentBundleUnresolvedKindSchema,
      element: z.string().openapi({ description: "The bundle element the caller must fix, named the way they authored it." }),
      detail: z.string(),
    }),
  );

  const AgentBundleSchema = registry.register(
    "AgentBundle",
    z.object({
      bundleVersion: z.literal(AGENT_BUNDLE_SCHEMA_VERSION),
      portability: z.record(AgentConfigPortabilityValueSchema).openapi({
        description: "Portability of the bundle's own top-level collections, keyed by field path (for example \"agentSkills[].config\").",
      }),
      agent: AgentBundleAgentConfigSchema,
      routines: z.array(AgentBundleRoutineSchema),
      contextVariables: z.array(AgentBundleContextVariableSchema),
      agentSkills: z.array(AgentBundleSkillSchema),
    }),
  );

  /**
   * Fields the current agent-config version has that the oldest still-accepted one
   * does not. Import reads every version in `SUPPORTED_AGENT_CONFIG_VERSIONS`
   * (`modules/agentBundle/importService.ts`), so a request schema demanding the
   * current field set would reject a bundle the backend imports happily — an SDK
   * consumer would have to cast around its own published contract.
   */
  const AGENT_CONFIG_FIELDS_ADDED_SINCE_OLDEST_SUPPORTED = {
    internalName: true,
    handoffOnRetrievalMiss: true,
  } as const;

  const AgentBundleImportAgentConfigSchema = registry.register(
    "AgentBundleImportAgentConfig",
    AgentBundleAgentConfigSchema
      .partial(AGENT_CONFIG_FIELDS_ADDED_SINCE_OLDEST_SUPPORTED)
      .openapi({
        description:
          "An agent configuration on any version this deployment reads. Fields introduced after the oldest "
          + "accepted version are optional; an older bundle that omits them imports with the behaviour that "
          + "version had. Export always emits the current version, with every field present.",
      }),
  );

  const AgentBundleImportSkillSchema = registry.register(
    "AgentBundleImportSkill",
    AgentBundleSkillSchema.partial({ config: true, omittedConfigKeys: true }).openapi({
      description:
        "A skill as accepted on import. `config` and `omittedConfigKeys` default to empty when absent, so a "
        + "hand-written bundle need not restate them.",
    }),
  );

  const AgentBundleImportRequestSchema = registry.register(
    "AgentBundleImportRequest",
    z.object({
      bundleVersion: z.number().int(),
      portability: z.record(AgentConfigPortabilityValueSchema).optional(),
      agent: AgentBundleImportAgentConfigSchema,
      routines: z.array(AgentBundleRoutineSchema).optional(),
      contextVariables: z.array(AgentBundleContextVariableSchema).optional(),
      agentSkills: z.array(AgentBundleImportSkillSchema).optional(),
      idempotencyKey: z.string().min(1).max(200).optional().openapi({
        description: "Caller-supplied key that replays a completed import in this workspace instead of creating another agent. A key whose import is still applying returns 409.",
      }),
    }).openapi({
      description:
        "A previously exported agent bundle. `bundleVersion` and `agent.schemaVersion` are checked against what "
        + "this deployment supports; an unsupported value fails the whole import with 400 rather than importing "
        + "partially. Collections default to empty when omitted.",
    }),
  );

  const AgentBundleImportResponseSchema = registry.register(
    "AgentBundleImportResponse",
    z.object({
      importId: z.string().uuid(),
      agentId: z.string().uuid(),
      unresolved: z.array(AgentBundleUnresolvedReferenceSchema),
    }),
  );

  const AgentBundleImportParamsSchema = registry.register(
    "AgentBundleImportParams",
    z.object({ importId: z.string().uuid() }),
  );

  const AgentBundleImportStatusSchema = registry.register(
    "AgentBundleImportStatus",
    z.object({
      id: z.string().uuid(),
      state: z.enum(["queued", "applying", "applied", "failed", "compensated"]),
      agentId: z.string().uuid().nullable(),
      unresolved: z.array(AgentBundleUnresolvedReferenceSchema),
      failureCode: z.enum(["invalid_bundle", "apply_failed"]).nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      appliedAt: z.string().datetime().nullable(),
      compensatedAt: z.string().datetime().nullable(),
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
    AgentChannelChatRequestSchema,
    AgentChannelCredentialIssueRequestSchema,
    AgentChannelCredentialIssueResponseSchema,
    AgentChannelCredentialListResponseSchema,
    AgentChannelCredentialListQuerySchema: agentChannelCredentialListQuerySchema,
    AgentChannelCredentialMetadataSchema,
    AgentChannelCredentialParamsSchema: agentChannelCredentialParamsSchema,
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
    AgentConfigRefPlaceholderSchema,
    AgentBundleAgentConfigSchema,
    AgentBundleRoutineSchema,
    AgentBundleContextVariableSchema,
    AgentBundleSkillSchema,
    AgentBundleUnresolvedKindSchema,
    AgentBundleUnresolvedReferenceSchema,
    AgentBundleSchema,
    AgentBundleImportRequestSchema,
    AgentBundleImportResponseSchema,
    AgentBundleImportParamsSchema,
    AgentBundleImportStatusSchema,
  });
};
