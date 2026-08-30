import type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableScope,
  ContextVariableSource,
  ContextVariableTrustTier,
  ContextVariableSensitivity,
  ContextVariableValue,
  ContextVariableValueType,
} from "./domain.js";
import type { ContextVariableSurfacing, ResolvedVariableInput } from "./contextResolutionService.js";

export interface ContextVariableCreateRecord {
  workspaceId: string;
  name: string;
  description?: string | null;
  valueType: ContextVariableValueType;
  trustTier: ContextVariableTrustTier;
  sensitivity: ContextVariableSensitivity;
  defaultSurfacing: ContextVariableSurfacing;
}

export interface ContextVariableUpdateRecord {
  name?: string;
  description?: string | null;
  valueType?: ContextVariableValueType;
  trustTier?: ContextVariableTrustTier;
  sensitivity?: ContextVariableSensitivity;
  defaultSurfacing?: ContextVariableSurfacing;
}

export interface AgentContextVariableEnablementRecord {
  agentId: string;
  variableId: string;
  source: ContextVariableSource;
  resolverSkillId?: string | null;
  maxAgeSeconds?: number | null;
  resolverTimeoutMs?: number | null;
  surfacing: ContextVariableSurfacing;
  enabled?: boolean;
}

/** Full replacement value for a variable definition used by proposal application. */
export interface ContextVariableDefinitionWrite {
  readonly name: string;
  readonly description: string | null;
  readonly valueType: ContextVariableValueType;
  readonly trustTier: ContextVariableTrustTier;
  readonly sensitivity: ContextVariableSensitivity;
  readonly defaultSurfacing: ContextVariableSurfacing;
}

/** Full replacement value for one agent's enablement used by proposal application. */
export interface ContextVariableEnablementWrite {
  readonly source: ContextVariableSource;
  readonly resolverSkillId: string | null;
  readonly maxAgeSeconds: number | null;
  readonly resolverTimeoutMs: number | null;
  readonly surfacing: ContextVariableSurfacing;
  readonly enabled: boolean;
}

export interface ApplyContextVariableProposalInput {
  readonly workspaceId: string;
  readonly agentId: string;
  /** Existing variable id, or null to create a new variable. */
  readonly variableId: string | null;
  /** Definition create/update, or null when the proposal only touches the enablement. */
  readonly definition: ContextVariableDefinitionWrite | null;
  /**
   * Required only when an existing variable definition is written: the variable's
   * `updated_at` at draft time. A fresh insert has no earlier row to version-gate.
   */
  readonly expectedVariableUpdatedAt: Date | null;
  /** Enablement upsert, or null when the proposal only touches the definition. */
  readonly enablement: ContextVariableEnablementWrite | null;
  /**
   * Draft-time enablement `updated_at`, or null when the proposal expects a fresh
   * agent-variable enablement. Ignored when enablement is null.
   */
  readonly expectedEnablementUpdatedAt: Date | null;
}

export interface ApplyContextVariableProposalResult {
  readonly variableId: string;
}

/** Full port implemented by infrastructure and consumed only by the owner service. */
export interface ContextVariableRepositoryPort {
  create(input: ContextVariableCreateRecord): Promise<ContextVariable>;
  update(workspaceId: string, id: string, input: ContextVariableUpdateRecord): Promise<ContextVariable | null>;
  delete(workspaceId: string, id: string): Promise<boolean>;
  listByWorkspace(workspaceId: string): Promise<ContextVariable[]>;
  get(workspaceId: string, id: string): Promise<ContextVariable | null>;
  upsertEnablement(input: AgentContextVariableEnablementRecord): Promise<AgentContextVariableEnablement>;
  deleteEnablement(agentId: string, variableId: string): Promise<boolean>;
  listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]>;
  upsertValue(variableId: string, scope: ContextVariableScope, data: unknown): Promise<ContextVariableValue>;
  readValue(variableId: string, scope: ContextVariableScope): Promise<ContextVariableValue | null>;
  deleteValue(variableId: string, scope: ContextVariableScope): Promise<boolean>;
  resolveForAgent(workspaceId: string, agentId: string, scopes: ContextVariableScope[]): Promise<ResolvedVariableInput[]>;
  /**
   * Applies definition and enablement writes atomically with version predicates. A
   * stale predicate throws conflict so neither half of a two-part proposal survives.
   */
  applyProposal(input: ApplyContextVariableProposalInput): Promise<ApplyContextVariableProposalResult>;
}

/** Turn-time resolver surface; its only write stores a resolved runtime cache value. */
export interface ContextVariableResolverRepositoryPort {
  resolveForAgent(workspaceId: string, agentId: string, scopes: ContextVariableScope[]): Promise<ResolvedVariableInput[]>;
  listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]>;
  readValue(variableId: string, scope: ContextVariableScope): Promise<ContextVariableValue | null>;
  upsertValue(variableId: string, scope: ContextVariableScope, data: unknown): Promise<ContextVariableValue>;
}

/** Turn-time read surface exposed to chat; resolution owns its backing reads. */
export interface ContextVariableResolutionReaderPort {
  resolveForAgent(workspaceId: string, agentId: string, scopes: ContextVariableScope[]): Promise<ResolvedVariableInput[]>;
}

/** Read surface required by routine authoring to inspect agent enablements. */
export interface ContextVariableEnablementReaderPort {
  listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]>;
}
