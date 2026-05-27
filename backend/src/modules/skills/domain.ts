import { z } from "zod";

import type { SkillDefinition as ContractSkillDefinition } from "@radioso/skill-contract";

export type { SkillDefinition } from "@radioso/skill-contract";

export const skillOwnerSchema = z.enum(["assistant", "retrieval", "documents", "mcp", "platform", "auth", "contact"]);
export type SkillOwner = z.infer<typeof skillOwnerSchema>;

export const skillExecutionClassSchema = z.enum(["interactive", "deferred", "administrative"]);
export type SkillExecutionClass = z.infer<typeof skillExecutionClassSchema>;

export const skillCallerSurfaceSchema = z.enum([
  "assistant",
  "retrieval_api",
  "sdk",
  "mcp",
  "dashboard",
  "public_embed",
]);
export type SkillCallerSurface = z.infer<typeof skillCallerSurfaceSchema>;

export const skillAvailabilitySchema = z.object({
  state: z.enum(["available", "forbidden", "unavailable"]),
  reason: z.string().optional(),
});
export type SkillAvailability = z.infer<typeof skillAvailabilitySchema>;

export const skillContractReferenceSchema = z.object({
  kind: z.enum(["http", "sdk", "mcp_tool", "documentation"]),
  label: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  path: z.string(),
});
export type SkillContractReference = z.infer<typeof skillContractReferenceSchema>;

export const skillDiagnosticsSummarySchema = z.object({
  defined: z.boolean(),
  shapeAware: z.boolean(),
  strategyAware: z.boolean(),
  supportedFields: z.array(z.string()).optional(),
});
export type SkillDiagnosticsSummary = z.infer<typeof skillDiagnosticsSummarySchema>;

export const skillDisplayMetadataSchema = z.object({
  icon: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});
export type SkillDisplayMetadata = z.infer<typeof skillDisplayMetadataSchema>;

export const skillSchemaReferencesSchema = z.object({
  inputSchemaRef: z.string(),
  settingsSchemaRef: z.string().optional(),
});
export type SkillSchemaReferences = z.infer<typeof skillSchemaReferencesSchema>;

export const skillIntakeFieldSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  type: z.enum(["string", "email", "phone", "number", "date", "enum"]),
  required: z.boolean(),
  sensitive: z.boolean().optional(),
  ttlSeconds: z.number().int().positive().optional(),
  pattern: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  maxLength: z.number().int().positive().optional(),
  extractionHint: z.string().optional(),
});
export type SkillIntakeField = z.infer<typeof skillIntakeFieldSchema>;

export const skillExecutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("internal"),
    adapter: z.string(),
    enqueue: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("webhook"),
    provider: z.enum(["make", "zapier", "custom"]),
    endpointId: z.string(),
    enqueue: z.boolean(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("delivery_pipeline"),
    adapter: z.string(),
    destinations: z.array(z.enum(["email", "webhook"])).min(1),
    enqueue: z.boolean(),
  }),
]);
export type SkillExecution = z.infer<typeof skillExecutionSchema>;

export const skillIntakeDefinitionSchema = z.object({
  enabled: z.boolean(),
  supportedCallers: z.array(skillCallerSurfaceSchema),
  intent: z.object({
    description: z.string(),
    examples: z.array(z.string()),
  }),
  fields: z.array(skillIntakeFieldSchema),
  subjectIdentityField: z.string().optional(),
  confirmation: z.enum(["none", "before_execute", "always"]),
  interruptionPolicy: z.enum(["pause_and_resume", "cancel_on_topic_change"]),
});
export type SkillIntakeDefinition = z.infer<typeof skillIntakeDefinitionSchema>;

export const skillGeneratedContractSchema = z.object({
  path: z.string(),
});
export type SkillGeneratedContract = z.infer<typeof skillGeneratedContractSchema>;

const skillStepSummarySchema = z.object({
  name: z.string(),
  kind: z.string(),
});
export type SkillStepSummary = z.infer<typeof skillStepSummarySchema>;

const skillShapeSummarySchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
});
export type SkillShapeSummary = z.infer<typeof skillShapeSummarySchema>;

export const skillOutcomeStatusSchema = z.enum([
  "active",
  "paused",
  "awaiting_confirmation",
  "awaiting_tool",
  "completed",
  "cancelled",
  "expired",
  "failed",
]);
export type SkillOutcomeStatus = z.infer<typeof skillOutcomeStatusSchema>;

export const skillOutcomeToneSchema = z.enum([
  "positive",
  "neutral",
  "info",
  "warning",
  "muted",
]);
export type SkillOutcomeTone = z.infer<typeof skillOutcomeToneSchema>;

export const skillOutcomeDefinitionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  status: skillOutcomeStatusSchema,
  groundedAnswer: z.boolean().optional(),
  tone: skillOutcomeToneSchema.optional(),
});
export type SkillOutcomeDefinition = z.infer<typeof skillOutcomeDefinitionSchema>;

export const skillCatalogEntrySchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  display: skillDisplayMetadataSchema.optional(),
  owner: skillOwnerSchema,
  executionClass: skillExecutionClassSchema,
  availability: skillAvailabilitySchema,
  supportedCallers: z.array(skillCallerSurfaceSchema),
  requiredCapabilities: z.array(z.string()),
  contractReferences: z.array(skillContractReferenceSchema),
  schemaReferences: skillSchemaReferencesSchema.optional(),
  intake: skillIntakeDefinitionSchema.optional(),
  execution: skillExecutionSchema.optional(),
  diagnostics: skillDiagnosticsSummarySchema,
  steps: z.array(skillStepSummarySchema).optional(),
  shapes: z.array(skillShapeSummarySchema).optional(),
  outcomes: z.array(skillOutcomeDefinitionSchema).optional(),
});
// requiredCapabilities is exposed as string[] (matching the runtime Zod
// schema). Capability names are validated through `capabilityPolicy.can`
// before any privileged work, so the TypeScript-only CapabilityName narrowing
// that used to live here was unsound and is no longer maintained.
export type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>;

export type SkillCatalogEntryDefinition = Omit<SkillCatalogEntry, "availability"> & {
  availability?: SkillAvailability;
  availabilityCheck?: "static" | "capability_policy";
  generatedContract?: SkillGeneratedContract;
};

export const skillCatalogResponseSchema = z.object({
  skills: z.array(skillCatalogEntrySchema),
});
export type SkillCatalogResponse = {
  skills: SkillCatalogEntry[];
};

export const skillParamsSchema = z.object({
  skillName: z.string().min(1),
});

export const skillCapabilityCheckSchema = z.object({
  capability: z.string(),
  allowed: z.boolean(),
  reason: z.string().optional(),
});

export const skillDiagnosticEvidenceSchema = z.object({
  queryShape: z.string().optional(),
  retrievalShape: z.string().optional(),
  retrievalStrategy: z.string().optional(),
  candidateSourceSummary: z.record(z.unknown()).optional(),
  ranking: z.record(z.unknown()).optional(),
  resolvedSteps: z.array(z.record(z.unknown())).optional(),
  evidenceStatus: z.enum(["found", "missing", "partial", "not_applicable"]).optional(),
  supportStatus: z.enum(["supported", "unsupported", "not_checked", "not_applicable"]).optional(),
  groundingOutcome: z.string().optional(),
});

export const skillDiagnosticSchema = z.object({
  skillName: z.string(),
  shapeName: z.string().optional(),
  strategy: z.string().optional(),
  selectionMode: z.enum(["deterministic", "probabilistic"]),
  selectionReason: z.string().optional(),
  selectionConfidence: z.number().min(0).max(1).optional(),
  callerSurface: skillCallerSurfaceSchema,
  capabilityChecks: z.array(skillCapabilityCheckSchema),
  parameters: z.record(z.unknown()).optional(),
  fallback: z.object({
    used: z.boolean(),
    reason: z.string().optional(),
    path: z.string().optional(),
  }).optional(),
  outcome: z.enum(["success", "unsupported", "forbidden", "failed", "skipped"]),
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
  }).optional(),
  evidence: skillDiagnosticEvidenceSchema.optional(),
});
export type SkillDiagnostic = z.infer<typeof skillDiagnosticSchema>;

export type SkillStepClauses = Record<string, unknown>;

export interface SkillStepDefinition {
  name: string;
  kind: string;
  displayName?: string;
  clauses: SkillStepClauses;
  trace?: {
    expose: boolean;
    redact?: string[];
  };
  telemetry?: {
    eventName?: string;
    tags?: string[];
  };
}

export type SkillStepOverride = Partial<SkillStepClauses>;

export interface SkillShapeDefinition {
  name: string;
  displayName?: string;
  description?: string;
  stepOverrides: Record<string, SkillStepOverride>;
}

// SkillDefinition is re-exported from @radioso/skill-contract above so OSS
// and Enterprise modules share a single typed shape. The Zod schema below
// remains the runtime contract; the static assertion at the bottom of this
// file fails the build if the inferred shape ever drifts from the contract.

export interface ResolvedSkillStep {
  name: string;
  kind: string;
  displayName?: string;
  clauses: SkillStepClauses;
  overrideApplied: boolean;
  appliedOverride?: SkillStepOverride;
}

export interface ResolvedSkillRun {
  skillName: string;
  shapeName: string;
  requestedShapeName?: string;
  shapeFound: boolean;
  resolvedSteps: ResolvedSkillStep[];
}

export const skillDiagnosticFieldNames = [
  "skillName",
  "shapeName",
  "strategy",
  "selectionMode",
  "selectionReason",
  "selectionConfidence",
  "callerSurface",
  "capabilityChecks",
  "parameters",
  "fallback",
  "outcome",
  "error",
  "evidence",
] as const;

export const validateSkillDiagnostic = (input: unknown) => skillDiagnosticSchema.safeParse(input);

export const skillStepDefinitionSchema = skillStepSummarySchema.extend({
  displayName: z.string().optional(),
  clauses: z.record(z.unknown()),
  trace: z.object({
    expose: z.boolean(),
    redact: z.array(z.string()).optional(),
  }).optional(),
  telemetry: z.object({
    eventName: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }).optional(),
});

export const skillShapeDefinitionSchema = skillShapeSummarySchema.extend({
  stepOverrides: z.record(z.record(z.unknown())),
});

export const skillDefinitionSchema = skillCatalogEntrySchema.omit({
  availability: true,
  steps: true,
  shapes: true,
}).extend({
  availability: skillAvailabilitySchema.optional(),
  availabilityCheck: z.enum(["static", "capability_policy"]).optional(),
  generatedContract: skillGeneratedContractSchema.optional(),
  steps: z.array(skillStepDefinitionSchema),
  shapes: z.array(skillShapeDefinitionSchema).optional(),
});

// Compile-time guard: fails the build if skillDefinitionSchema ever infers a
// shape that no longer matches the @radioso/skill-contract SkillDefinition.
type _SkillDefinitionContractAssertion = z.infer<typeof skillDefinitionSchema> extends ContractSkillDefinition
  ? ContractSkillDefinition extends z.infer<typeof skillDefinitionSchema>
    ? true
    : never
  : never;
const _skillDefinitionContractAssertion: _SkillDefinitionContractAssertion = true;
void _skillDefinitionContractAssertion;
