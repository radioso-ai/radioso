/**
 * Skill definition shape shared between OSS and Enterprise editions.
 *
 * OSS owns the runtime Zod schemas (in `backend/src/modules/skills/domain.ts`)
 * and validates instances at boundaries. This file is the typed surface that
 * other packages — including Enterprise modules that cannot import OSS runtime
 * code — depend on. Keep field names, enum members, and optionality in sync
 * with the OSS Zod schemas.
 */

export type SkillOwner =
  | "assistant"
  | "retrieval"
  | "documents"
  | "mcp"
  | "platform"
  | "auth"
  | "contact";

export type SkillExecutionClass = "interactive" | "deferred" | "administrative";

export type SkillCallerSurface =
  | "assistant"
  | "retrieval_api"
  | "sdk"
  | "mcp"
  | "dashboard"
  | "public_embed";

export type SkillTurnStatus =
  | "active"
  | "paused"
  | "awaiting_confirmation"
  | "awaiting_tool"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export type SkillOutcomeTone = "positive" | "neutral" | "info" | "warning" | "muted";

export interface SkillDisplayMetadata {
  icon?: string;
  title?: string;
}

export interface SkillContractReference {
  kind: "http" | "sdk" | "mcp_tool" | "documentation";
  label: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
}

export interface SkillIntakeField {
  name: string;
  displayName: string;
  type: "string" | "email" | "phone" | "number" | "date" | "enum";
  required: boolean;
  sensitive?: boolean;
  ttlSeconds?: number;
  pattern?: string;
  enumValues?: string[];
  maxLength?: number;
  extractionHint?: string;
}

export interface SkillIntakeDefinition {
  enabled: boolean;
  supportedCallers: SkillCallerSurface[];
  intent: {
    description: string;
    examples: string[];
  };
  fields: SkillIntakeField[];
  subjectIdentityField?: string;
  confirmation: "none" | "before_execute" | "always";
  interruptionPolicy: "pause_and_resume" | "cancel_on_topic_change";
}

export type SkillExecution =
  | {
      kind: "internal";
      adapter: string;
      enqueue?: boolean;
    }
  | {
      kind: "webhook";
      provider: "make" | "zapier" | "custom";
      endpointId: string;
      enqueue: boolean;
      timeoutMs?: number;
    }
  | {
      kind: "delivery_pipeline";
      adapter: string;
      destinations: Array<"email" | "webhook">;
      enqueue: boolean;
    };

export interface SkillDiagnosticsSummary {
  defined: boolean;
  shapeAware: boolean;
  strategyAware: boolean;
  supportedFields?: string[];
}

export interface SkillSchemaReferences {
  inputSchemaRef: string;
  settingsSchemaRef?: string;
}

export interface SkillGeneratedContract {
  path: string;
}

export interface SkillAvailability {
  state: "available" | "forbidden" | "unavailable";
  reason?: string;
}

export interface SkillOutcomeDefinition {
  name: string;
  displayName: string;
  description?: string;
  status: SkillTurnStatus;
  groundedAnswer?: boolean;
  tone?: SkillOutcomeTone;
}

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

export interface SkillDefinition {
  name: string;
  displayName: string;
  description: string;
  display?: SkillDisplayMetadata;
  owner: SkillOwner;
  executionClass: SkillExecutionClass;
  availability?: SkillAvailability;
  availabilityCheck?: "static" | "capability_policy";
  supportedCallers: SkillCallerSurface[];
  requiredCapabilities: string[];
  contractReferences: SkillContractReference[];
  schemaReferences?: SkillSchemaReferences;
  intake?: SkillIntakeDefinition;
  execution?: SkillExecution;
  diagnostics: SkillDiagnosticsSummary;
  generatedContract?: SkillGeneratedContract;
  steps: SkillStepDefinition[];
  shapes?: SkillShapeDefinition[];
  outcomes?: SkillOutcomeDefinition[];
}
