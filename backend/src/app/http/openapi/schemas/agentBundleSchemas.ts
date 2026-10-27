import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  AGENT_CONFIG_SCHEMA_VERSION,
  agentSurfacePositions,
  authoredDirectiveRouteValues,
} from "../../../../modules/agents/public.js";
import type { AgentConfig } from "../../../../modules/agents/public.js";
import { routineDefinitionDraftInputSchema } from "../../../../modules/routines/public.js";
import { AGENT_BUNDLE_SCHEMA_VERSION } from "../../../../modules/agentBundle/public.js";
import { nullableComponent } from "../zodOpenApiExtension.js";

// Bundle collections are name-keyed, not id-keyed: see `agentBundle/domain.ts`
// for why. The enums below mirror the route-level validation in
// `agentBundleRoutes.ts` rather than importing zod schemas cross-module.
const AgentConfigPortabilityValueSchema = z.enum(["portable", "ref", "secret"]);
const AgentBundleContextVariableSourceSchema = z.enum(["pushed", "browser", "resolver", "request"]);
const AgentBundleContextVariableSurfacingSchema = z.enum(["always", "on_reference", "operator_only"]);
const AgentBundleSkillInvocationModeSchema = z.enum(["default_answer", "routine_named", "agent_selectable"]);

/** The agent schemas a bundle's agent config embeds; `registerAgentSchemas` registers them first. */
type AgentBundleSchemaDependencies = Record<
  "AgentMechanicsRepliesSchema" | "AgentPrivacyNoticesSchema" | "AnswerCoverageCriteriaSchema" | "AuthoredDirectiveBindingSchema" | "AuthoredDirectiveConditionSchema" | "AuthoredDirectiveLifecycleSchema" | "GenerationSurfaceSchema",
  z.ZodType
>;

/**
 * Registers the agent bundle export/import contract. Called from `registerAgentSchemas` after the
 * agent schemas it embeds, so component registration order (and the generated document) holds.
 */
export const registerAgentBundleSchemas = (registry: OpenAPIRegistry, dependencies: AgentBundleSchemaDependencies) => {
  const {
    AgentMechanicsRepliesSchema,
    AgentPrivacyNoticesSchema,
    AnswerCoverageCriteriaSchema,
    AuthoredDirectiveBindingSchema,
    AuthoredDirectiveConditionSchema,
    AuthoredDirectiveLifecycleSchema,
    GenerationSurfaceSchema,
  } = dependencies;

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

  const AgentBundleWebsiteEmbedSchema = z.object({
    enabled: z.boolean(),
    token: z.union([AgentConfigSecretPlaceholderSchema, z.null()]),
    allowedOrigins: z.array(AgentConfigRefPlaceholderSchema),
    launcherLabel: z.string(),
    launcherPosition: z.enum(agentSurfacePositions),
    theme: AgentBundleThemeSchema,
    copy: z.record(z.string(), z.record(z.string(), z.string())),
    expertOverrides: z.record(z.string(), z.string()),
    voiceCallsOffered: z.boolean().optional(),
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
      lifecycle: nullableComponent(AuthoredDirectiveLifecycleSchema),
      coverageCriteria: AnswerCoverageCriteriaSchema.optional(),
      enabled: z.boolean(),
      metadata: z.record(z.string(), z.unknown()),
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
        boundParams: z.record(z.string(), z.unknown()),
        exposedParams: z.record(z.string(), z.object({
          description: z.string().optional(),
          slotBinding: z.string().optional(),
          required: z.boolean().optional(),
        })),
        declaredOutcomes: z.array(z.string()).nullable(),
        outcomeMap: z.record(z.string(), z.string()).nullable(),
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
      portability: z.record(z.string(), z.enum(["portable", "ref", "secret"])).openapi({
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
        privacyNotice: AgentPrivacyNoticesSchema.optional(),
      }),
      greetingInstruction: z.string(),
      assistantDefaultLocale: z.string().nullable(),
      proactiveGreetingEnabled: z.boolean(),
      mechanicsReplies: AgentMechanicsRepliesSchema.optional().openapi({
        description: "Absent from bundles exported before the field existed; an import reads that as nothing authored.",
      }),
      surfaceSettings: z.object({
        authenticatedChat: z.object({ enabled: z.boolean() }),
        anonymousChat: z.object({
          enabled: z.boolean(),
          token: z.union([AgentConfigSecretPlaceholderSchema, z.null()]),
        }),
        websiteEmbed: AgentBundleWebsiteEmbedSchema,
        extensions: z.record(z.string(), z.unknown()).openapi({
          description: "Surface extensions keyed by extension id; shape is owned by the contributing extension.",
        }),
      }),
      skillSettings: z.record(z.string(), z.unknown()).openapi({
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
      config: z.record(z.string(), z.unknown()).openapi({ description: "Only the fields a capability marked portable." }),
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
      "chat_model_unavailable",
    ]).openapi({
      description: [
        "Why a bundle element could not be fully applied to the target workspace. Every element is reported",
        "rather than silently dropped: a bundle that imports quietly minus a skill binding is an agent that",
        "looks configured and answers wrong.",
        "- context_variable_missing: the bundle names a context variable that does not exist in this workspace.",
        "- resolver_skill_missing: the enablement's resolver skill did not survive import, so it stays unbound.",
        "- skill_target_unbound: the skill's connection target is a credential-bearing workspace row.",
        "- skill_capability_unknown: no capability with this id is registered in this deployment.",
        "- routine_invalid: the routine imported out of service (disabled) because it does not pass validation.",
        "- document_source_unresolved: selected document sources cannot be matched; scope imports empty, not \"all\".",
        "- surface_credential_unbound: a surface whose token cannot travel; imported disabled so it cannot serve.",
        "- mcp_connection_unbound: an external MCP connection reference; the skill imports without its server.",
        "- asset_not_portable: binary stored outside the database (the logo); not part of the bundle.",
        "- skill_config_not_portable: a skill setting whose value the capability keeps inside its own workspace.",
        "- directive_binding_unbound: a directive bound to a skill that did not survive import; kept, but disabled.",
        "- contact_delivery_unbound: contact requests are on but their destination stayed in the source workspace.",
        "- chat_model_unavailable: the agent's chat model override is one this workspace cannot run; the agent imports without it.",
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
      portability: z.record(z.string(), AgentConfigPortabilityValueSchema).openapi({
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
      portability: z.record(z.string(), AgentConfigPortabilityValueSchema).optional(),
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
      replayed: z.boolean().openapi({ description: "True when this is the completed result of a prior request with the same idempotencyKey." }),
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

  return {
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
  };
};
