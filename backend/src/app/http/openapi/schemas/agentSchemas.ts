import { z } from "zod";
import { publicChatSessionSchema } from "../../routes/publicChatRouteSchemas.js";
import { createRevisionCandidateBodySchema, publishRevisionBodySchema } from "../../routes/agentRevisionRequestSchemas.js";
import {
  agentChannelChatSchema,
  agentChannelCredentialIssueSchema,
  agentChannelCredentialLabelSchema,
  agentChannelCredentialListQuerySchema,
  agentChannelCredentialParamsSchema,
} from "../../schemas/agentChannelSchemas.js";
import {
  AGENT_MECHANICS_REPLIES_MAX_LOCALES,
  agentMechanicsRepliesSchema,
  agentPrivacyNoticesInputSchema,
  agentPrivacyNoticesSchema,
  agentSurfacePositions,
  authoredDirectiveSurfaceValues,
} from "../../../../modules/agents/public.js";
import {
  routineDefinitionDraftInputSchema,
  routineDefinitionDraftUpdateInputSchema,
  routineDraftAssistRequestSchema,
  routineValidationCodes,
} from "../../../../modules/routines/public.js";
import { skillDisplayMetadataSchema, skillOutcomeStatusSchema } from "../../../../modules/skills/public.js";
import { exactContentItemSchema } from "../../../../shared/domain/exactContent.js";
import { LOCALE_TAG_PATTERN } from "../../../../shared/domain/locale.js";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { nullableComponent } from "../zodOpenApiExtension.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";
import { registerAgentBundleSchemas } from "./agentBundleSchemas.js";
import { documentSourceIdSchema } from "../../../../modules/documents/contracts/index.js";
import {
  registerAgentVoiceSettingsSchemas,
  registerPublicVoiceSessionSchemas,
  registerVoiceCallReadinessSchema,
} from "./voiceSchemas.js";

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
        copy: z.record(z.string(), z.record(z.string(), z.string())),
        expertOverrides: z.record(z.string(), z.string()),
        voiceCallsOffered: z.boolean().openapi({
          description: "The operator offers voice calls from the website embed: its composer shows Talk while the agent's voice is also on, bound to a runtime and the workspace holds the vendor key. Defaults to false.",
        }),
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
        sourceIds: z.array(documentSourceIdSchema).max(200),
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

  const { AgentVoiceSettingsSchema, AgentVoiceSettingsUpdateSchema } = registerAgentVoiceSettingsSchemas(registry);

  // The record's key and locale-count refinements are runtime checks the generator cannot see, so
  // both are stated for generated clients and MCP callers. OpenAPI 3.1 schemas are JSON Schema
  // 2020-12, which has `propertyNames`; the generator's metadata type omits that keyword, so the
  // bounds are spread in rather than written inline.
  const mechanicsRepliesKeyBounds: { propertyNames: { type: "string"; pattern: string }; maxProperties: number } = {
    propertyNames: { type: "string", pattern: LOCALE_TAG_PATTERN.source },
    maxProperties: AGENT_MECHANICS_REPLIES_MAX_LOCALES,
  };
  const AgentMechanicsRepliesSchema = registry.register(
    "AgentMechanicsReplies",
    agentMechanicsRepliesSchema.openapi({
      description:
        "What the agent says, word for word, to a greeting, thanks, farewell, or acknowledgement, keyed by language tag "
        + "(at most 10). Each locale entry holds every mechanic, each with at most 5 lines of 1 to 200 characters. "
        + "When a turn is one of these mechanics and the agent has a line for it in the turn's language, the reply is an "
        + "authored line, rotated per conversation. An update replaces the block whole.",
      ...mechanicsRepliesKeyBounds,
    }),
  );

  const VoiceCallReadinessSchema = registerVoiceCallReadinessSchema(registry);

  const privacyNoticeKeyBounds: { propertyNames: { type: "string"; pattern: string }; maxProperties: number } = {
    propertyNames: { type: "string", pattern: LOCALE_TAG_PATTERN.source },
    maxProperties: 10,
  };
  const AgentPrivacyNoticesSchema = registry.register(
    "AgentPrivacyNotices",
    agentPrivacyNoticesSchema.openapi({
      ...privacyNoticeKeyBounds,
      description:
        "The agent's privacy notice, keyed by language tag (at most 10): one line (`text`, 1 to 200 characters) and a link to the "
        + "operator's policy (`url`, http or https, at most 500 characters). Chat surfaces show it before the visitor's first message, "
        + "the first reply of an email conversation carries it, and a voice session start hands it to the call. `version` is derived "
        + "from the language, line and link: the same notice keeps its version, a changed one gets a new one. Empty until the operator writes one.",
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
      handoffOnRetrievalMiss: z.boolean(),
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
        privacyNotice: AgentPrivacyNoticesSchema.optional(),
      }),
      retrievalEnabled: z.boolean(),
      sourceScope: AgentSourceScopeSchema,
      logo: schemas.AgentLogoSchema,
      greetingInstruction: z.string(),
      assistantDefaultLocale: z.string().nullable(),
      proactiveGreetingEnabled: z.boolean(),
      voice: AgentVoiceSettingsSchema,
      mechanicsReplies: AgentMechanicsRepliesSchema,
      assistantBootstrapActive: z.boolean(),
      publicId: z.string().nullable().openapi({
        description: "Identifier other agents address this agent by. Null until the agent card is published; rotate it to drop every connected caller.",
      }),
      publicDescription: z.string().openapi({
        description: "Operator-authored sentence the agent's public cards carry.",
      }),
      agentCardEnabled: z.boolean(),
      publicAgentAccessEnabled: z.boolean().openapi({
        description: "Whether a calling agent may connect with the public id and no credential. Requires agentCardEnabled.",
      }),
      walkInConversationsPerHour: z.number().int().nullable().openapi({
        description: "Per-agent walk-in conversation budget. Null leaves the deployment default in charge.",
      }),
      chatModelOverride: z.object({
        provider: z.enum(["openai", "openai-compatible", "gemini", "claude"]),
        model: z.string(),
      }).nullable(),
      skillSettings: z.record(z.string(), z.unknown()),
      surfaceSettings: ConversationAgentSurfaceSettingsSchema,
    }),
  );

  const AgentDetailSchema = registry.register(
    "AgentDetail",
    ConversationAgentSchema.extend({
      voiceCallReadiness: VoiceCallReadinessSchema.optional().openapi({
        description: "Present for dashboard sessions: whether the agent's voice is ready for the website embed's calls switch.",
      }),
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
      handoffOnRetrievalMiss: z.boolean().optional(),
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
        privacyNotice: agentPrivacyNoticesInputSchema.optional().openapi({
          description: "Replaces the stored notices whole: name every language the agent keeps. A `version` sent along is ignored.",
        }),
      }).optional().openapi({
        description: "Replaced whole: a field left out takes its default (`hidePoweredBy` false, no policy link, no privacy notice).",
      }),
      retrievalEnabled: z.boolean().optional(),
      sourceScope: z.discriminatedUnion("mode", [
        z.object({
          mode: z.literal("all"),
        }),
        z.object({
          mode: z.literal("selected"),
          sourceIds: z.array(documentSourceIdSchema).max(200),
        }),
      ]).optional(),
      greetingInstruction: z.string().max(200).optional(),
      assistantDefaultLocale: z.string().max(35).nullable().optional(),
      proactiveGreetingEnabled: z.boolean().optional(),
      voice: AgentVoiceSettingsUpdateSchema.optional(),
      mechanicsReplies: AgentMechanicsRepliesSchema.optional(),
      publicDescription: z.string().max(500).optional(),
      agentCardEnabled: z.boolean().optional(),
      publicAgentAccessEnabled: z.boolean().optional(),
      walkInConversationsPerHour: z.number().int().min(1).max(100_000).nullable().optional(),
      chatModelOverride: z.union([
        z.null(),
        z.object({
          provider: z.enum(["openai", "openai-compatible", "gemini", "claude"]),
          model: z.string().min(1).max(200),
        }),
      ]).optional(),
      skillSettings: z.record(z.string(), z.unknown()).optional(),
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
          copy: z.record(z.string(), z.record(z.string(), z.string())).optional(),
          expertOverrides: z.record(z.string(), z.string()).optional(),
          voiceCallsOffered: z.boolean().optional(),
        }).optional(),
      }).optional(),
    }),
  );

  const AgentParamsSchema = z.object({
    agentId: z.string().uuid(),
  });
  const AgentRevisionParamsSchema = z.object({ agentId: z.string().uuid(), revisionId: z.string().uuid() });
  const AgentRevisionSummarySchema = registry.register("AgentRevisionSummary", z.object({ id: z.string().uuid(), label: z.string(), kind: z.enum(["candidate", "published"]), versionNumber: z.number().int().positive().nullable(), createdAt: z.string().datetime(), publishedAt: z.string().datetime().optional() }));
  const AgentRevisionStateSchema = registry.register("AgentRevisionState", z.object({ agentId: z.string().uuid(), status: z.enum(["unpublished", "draft_clean", "draft_dirty", "published_changed_since_draft"]), draft: z.object({ generation: z.number().int().positive(), basePublishedRevisionId: z.string().uuid().nullable(), updatedAt: z.string().datetime() }), publishedRevision: z.union([AgentRevisionSummarySchema, z.null()]), canPublish: z.boolean(), proactiveGreetingEnabled: z.boolean() }));
  const AgentRevisionCandidateRequestSchema = registry.register("AgentRevisionCandidateRequest", createRevisionCandidateBodySchema);
  const AgentRevisionCandidateResponseSchema = registry.register("AgentRevisionCandidateResponse", z.object({ candidate: AgentRevisionSummarySchema }));
  const AgentRevisionListResponseSchema = registry.register("AgentRevisionListResponse", z.object({ revisions: z.array(AgentRevisionSummarySchema) }));
  // Exact greeting content (spec 1150 Slice A). `ExactContentItemSchema` mirrors the shared
  // domain contract (`backend/src/shared/domain/exactContent.ts`) directly rather than
  // hand-duplicating it, so authoring, candidate/publish validation, and this documented
  // contract cannot silently drift apart.
  const ExactContentVariantSchema = registry.register("ExactContentVariant", z.object({ locale: z.string().min(1), body: z.string(), chipLabels: z.record(z.string(), z.string()) }));
  const ExactContentItemSchema = registry.register("ExactContentItem", exactContentItemSchema.extend({ variants: z.array(ExactContentVariantSchema) }));
  const AgentGreetingDraftSchema = registry.register("AgentGreetingDraft", z.object({ exactWordsEnabled: z.boolean(), exactContent: z.union([ExactContentItemSchema, z.null()]) }));
  const AgentGreetingValidationSchema = registry.register("AgentGreetingValidation", z.object({ ok: z.boolean(), issues: z.array(z.object({ path: z.string(), code: z.string(), message: z.string() })).optional() }));
  const AgentGreetingDraftResponseSchema = registry.register("AgentGreetingDraftResponse", z.object({ greeting: AgentGreetingDraftSchema, validation: AgentGreetingValidationSchema }));
  const AgentRevisionDetailResponseSchema = registry.register("AgentRevisionDetailResponse", z.object({ revision: AgentRevisionSummarySchema.extend({ snapshotFormatVersion: z.literal(1), scope: z.object({ customInstructions: z.literal(true), directives: z.literal(true), routines: z.literal(true), contextVariableEnablements: z.literal(true), greeting: z.literal(true) }), dependencyWarnings: z.array(z.object({ code: z.string(), message: z.string() })), enabledContextVariableIds: z.array(z.string().uuid()), scopedChanges: z.object({ customInstruction: z.object({ before: z.string().nullable(), after: z.string().nullable(), changed: z.boolean() }), directives: z.array(z.object({ id: z.string().uuid(), change: z.enum(["added", "removed", "changed"]), before: z.unknown().optional(), after: z.unknown().optional() })), routines: z.array(z.object({ definitionId: z.string().uuid(), change: z.enum(["added", "removed", "changed"]), before: z.unknown().optional(), after: z.unknown().optional() })), contextVariableEnablements: z.array(z.object({ contextVariableId: z.string().uuid(), change: z.enum(["added", "removed", "changed"]), before: z.unknown().optional(), after: z.unknown().optional() })), greeting: z.object({ before: AgentGreetingDraftSchema, after: AgentGreetingDraftSchema, changed: z.boolean() }) }) }) }));
  const AgentRevisionPublishRequestSchema = registry.register("AgentRevisionPublishRequest", publishRevisionBodySchema);
  const AgentRevisionPublishResponseSchema = registry.register("AgentRevisionPublishResponse", z.object({ publication: z.object({ id: z.string().uuid(), revisionId: z.string().uuid(), publishedAt: z.string().datetime(), idempotentReplay: z.boolean(), revision: AgentRevisionSummarySchema }), state: AgentRevisionStateSchema }));

  const AgentAssistantLogoQuerySchema = z.object({
    workspaceId: z.string().uuid().optional(),
    v: z.string().optional(),
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
      expiresAt: z.string().datetime().nullable().openapi({
        description: "When the credential stops working. `null` means it never expires: it works until it is rotated or revoked.",
      }),
      lastUsedAt: z.string().datetime().nullable(),
      revokedAt: z.string().datetime().nullable(),
    }),
  );

  const AgentChannelCredentialIssueRequestSchema = registry.register(
    "AgentChannelCredentialIssueRequest",
    agentChannelCredentialIssueSchema.extend({
      expiresAt: agentChannelCredentialIssueSchema.shape.expiresAt.openapi({
        description: "A future instant when the credential stops working. Omit it, or send `null`, for a credential that never expires: "
          + "it works until it is rotated or revoked.",
      }),
    }),
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
  const AnswerCoverageCriteriaSchema = registry.register(
    "AnswerCoverageCriteria",
    z.object({
      coverage: z.array(z.enum(["answered", "partial", "unanswered", "unclear"])).min(1),
      reasons: z.array(z.enum(["sufficient_evidence", "insufficient_evidence", "conflicting_evidence", "ambiguous_request", "intentional_scope_boundary"])).min(1).optional(),
    }),
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
    lifecycle: nullableComponent(AuthoredDirectiveLifecycleSchema).optional(),
    coverageCriteria: AnswerCoverageCriteriaSchema.optional(),
    enabled: z.boolean().optional().openapi({
      description: "Reversible off switch. A disabled directive keeps its authored text but never reaches the matcher. Defaults to true.",
    }),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }).strict();

  const AuthoredDirectiveCreateRequestSchema = registry.register(
    "AuthoredDirectiveCreateRequest",
    AuthoredDirectiveRequestBaseSchema,
  );

  const AuthoredDirectiveUpdateRequestSchema = registry.register(
    "AuthoredDirectiveUpdateRequest",
    AuthoredDirectiveRequestBaseSchema.partial().extend({
      // PATCH omission preserves the stored condition; explicit null removes it.
      coverageCriteria: z.union([AnswerCoverageCriteriaSchema, z.null()]).optional(),
    }).strict(),
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
      lifecycle: nullableComponent(AuthoredDirectiveLifecycleSchema),
      coverageCriteria: AnswerCoverageCriteriaSchema.optional(),
      enabled: z.boolean(),
      metadata: z.record(z.string(), z.unknown()),
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
    z.union([
      z.object({ enabled: z.boolean() }).strict(),
      // No defaults on `enabled`, `activation.reentryMode`, or any `completionExport` field
      // here, unlike the create schema: an update payload that omits one must carry the
      // stored value forward rather than silently resetting it. Mirrors
      // `routineDefinitionPatchBodySchema` in `../routes/agentRoutes.ts`.
      routineDefinitionDraftUpdateInputSchema,
    ]),
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
      copy: z.record(z.string(), z.record(z.string(), z.string())).optional(),
      branding: z.object({
        hidePoweredBy: z.boolean(),
        privacyPolicyUrl: z.string().nullable(),
        privacyNotice: AgentPrivacyNoticesSchema.optional(),
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

  registerPublicVoiceSessionSchemas(registry, schemas);

  const WorkspaceIngestionReprocessResponseSchema = registry.register(
    "WorkspaceIngestionReprocessResponse",
    z.object({
      workspaceId: z.string().uuid(),
      queuedDocumentCount: z.number().int().min(0),
      skippedDocumentCount: z.number().int().min(0),
      status: z.enum(["queued", "noop"]),
    }),
  );

  const bundleSchemas = registerAgentBundleSchemas(registry, {
    AgentMechanicsRepliesSchema,
    AgentPrivacyNoticesSchema,
    AnswerCoverageCriteriaSchema,
    AuthoredDirectiveBindingSchema,
    AuthoredDirectiveConditionSchema,
    AuthoredDirectiveLifecycleSchema,
    GenerationSurfaceSchema,
  });

  Object.assign(schemas, {
    AgentSchema,
    AgentPrivacyNoticesSchema,
    AgentContactRequestDeliverySchema,
    AgentContactRequestDeliveryRequestSchema,
    ConversationAgentSurfaceSettingsSchema,
    AgentSourceScopeSchema,
    ConversationAgentSchema,
    AgentDetailSchema,
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
    AgentRevisionParamsSchema,
    AgentRevisionStateSchema,
    AgentGreetingDraftSchema,
    AgentGreetingDraftResponseSchema,
    AgentRevisionCandidateRequestSchema,
    AgentRevisionCandidateResponseSchema,
    AgentRevisionListResponseSchema,
    AgentRevisionDetailResponseSchema,
    AgentRevisionPublishRequestSchema,
    AgentRevisionPublishResponseSchema,
    AgentAssistantLogoQuerySchema,
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
    RoutineSkillCatalogResponseSchema,
    SkillAuthoringDescriptorSchema,
    RoutineDefinitionResponseSchema,
    RoutineDefinitionSaveResponseSchema,
    RoutineDefinitionUpdateRequestSchema,
    RoutineDefinitionValidateResponseSchema,
    RoutineValidationResultSchema,
    PublicChatSessionResponseSchema,
    PublicChatSessionRequestSchema,
    WorkspaceIngestionReprocessResponseSchema,
    ...bundleSchemas,
  });
};
