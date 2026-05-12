import { z } from "zod";

import type { CapabilityName } from "../../shared/domain/capabilityPolicy.js";

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

export const skillSchemaReferencesSchema = z.object({
  inputSchemaRef: z.string(),
  settingsSchemaRef: z.string().optional(),
});
export type SkillSchemaReferences = z.infer<typeof skillSchemaReferencesSchema>;

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

export const skillCatalogEntrySchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  owner: skillOwnerSchema,
  executionClass: skillExecutionClassSchema,
  availability: skillAvailabilitySchema,
  supportedCallers: z.array(skillCallerSurfaceSchema),
  requiredCapabilities: z.array(z.string()),
  contractReferences: z.array(skillContractReferenceSchema),
  schemaReferences: skillSchemaReferencesSchema.optional(),
  diagnostics: skillDiagnosticsSummarySchema,
  steps: z.array(skillStepSummarySchema).optional(),
  shapes: z.array(skillShapeSummarySchema).optional(),
});
export type SkillCatalogEntry = Omit<z.infer<typeof skillCatalogEntrySchema>, "requiredCapabilities"> & {
  requiredCapabilities: CapabilityName[];
};

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

export interface SkillDefinition extends SkillCatalogEntryDefinition {
  steps: SkillStepDefinition[];
  shapes?: SkillShapeDefinition[];
}

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
