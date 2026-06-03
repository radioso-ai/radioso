import type {
  SkillDefinition as ContractSkillDefinition,
  SkillOutcome,
  SkillOutcomeControl,
  SkillOutcomeStatus,
  SkillTransientGuidance,
} from "@radioso/conversation-contract";

export type { SkillOutcome, SkillOutcomeControl, SkillOutcomeStatus, SkillTransientGuidance };

export interface NamedSkillCatalogEntry {
  name: string;
}

export interface SkillAvailability {
  state: "available" | "forbidden" | "unavailable";
  reason?: string;
}

export type SkillExecution =
  | { kind: "internal"; adapter: string; enqueue?: boolean }
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

export interface SkillCatalogEntryDefinition extends ContractSkillDefinition {
  displayName?: string;
  owner?: string;
  executionClass?: string;
  availability?: SkillAvailability;
  availabilityCheck?: "static" | "capability_policy";
  supportedCallers?: string[];
  requiredCapabilities?: string[];
  contractReferences?: Array<Record<string, unknown>>;
  schemaReferences?: Record<string, unknown>;
  intake?: Record<string, unknown>;
  execution?: SkillExecution;
  diagnostics?: Record<string, unknown>;
  generatedContract?: Record<string, unknown>;
  steps?: SkillStepDefinition[];
  shapes?: SkillShapeDefinition[];
  outcomes?: Array<Record<string, unknown>>;
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

export interface ResolvableSkillDefinition extends ContractSkillDefinition {
  steps: SkillStepDefinition[];
  shapes?: SkillShapeDefinition[];
}
