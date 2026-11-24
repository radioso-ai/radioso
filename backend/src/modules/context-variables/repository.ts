import type { ConversationSkillSet } from "../../shared/domain/conversationSkills.js";
import type { OwnerCommitHook } from "../../shared/infra/kysely/types.js";
import type {
  AgentContextVariableEnablement,
  ContextValueWriter,
  ContextValueWriterKind,
  ContextVariable,
  ContextVariableOption,
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
  options?: readonly ContextVariableOption[] | null;
  trustTier: ContextVariableTrustTier;
  sensitivity: ContextVariableSensitivity;
  defaultSurfacing: ContextVariableSurfacing;
}

export interface ContextVariableUpdateRecord {
  name?: string;
  description?: string | null;
  valueType?: ContextVariableValueType;
  options?: readonly ContextVariableOption[] | null;
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
  readonly options: readonly ContextVariableOption[] | null;
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

/** A reviewed execution's receipt, written in the proposal's own transaction so the two commit together. */
export interface ApplyContextVariableProposalOptions {
  readonly onCommitted?: OwnerCommitHook<ApplyContextVariableProposalResult>;
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
  /**
   * Stores a value under the overwrite rule (`mayOverwrite`); null when the stored value is kept.
   * A `conversation` scope must name a conversation of the variable's workspace.
   */
  upsertValue(variableId: string, scope: ContextVariableScope, data: unknown, writtenBy: ContextValueWriter): Promise<ContextVariableValue | null>;
  readValue(variableId: string, scope: ContextVariableScope): Promise<ContextVariableValue | null>;
  /** Deletes the value; whether a row went. A conversation's change is recorded against `deletedBy`. */
  deleteValue(variableId: string, scope: ContextVariableScope, deletedBy: ContextValueWriter): Promise<boolean>;
  /** Deletes the value only when one of `writerKinds` wrote it, decided in the delete itself; whether a row went. */
  deleteValueWrittenBy(
    variableId: string,
    scope: ContextVariableScope,
    writerKinds: readonly ContextValueWriterKind[],
    deletedBy: ContextValueWriter,
  ): Promise<boolean>;
  /** Whether any scope holds a value of the variable. */
  hasValues(variableId: string): Promise<boolean>;
  /** The agents whose draft has the classifier fill the variable (an enabled `classified` enablement). */
  classifiedEnablementAgentIds(variableId: string): Promise<string[]>;
  resolveForAgent(workspaceId: string, agentId: string, scopes: ContextVariableScope[]): Promise<ResolvedVariableInput[]>;
  /**
   * Applies definition and enablement writes atomically with version predicates. A
   * stale predicate throws conflict so neither half of a two-part proposal survives.
   * `onCommitted` runs in the same transaction, after both writes.
   */
  applyProposal(input: ApplyContextVariableProposalInput, options?: ApplyContextVariableProposalOptions): Promise<ApplyContextVariableProposalResult>;
}

/** Turn-time resolver surface; its only write stores a resolved runtime cache value. */
export interface ContextVariableResolverRepositoryPort {
  get(workspaceId: string, id: string): Promise<ContextVariable | null>;
  resolveForAgent(workspaceId: string, agentId: string, scopes: ContextVariableScope[]): Promise<ResolvedVariableInput[]>;
  listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]>;
  readValue(variableId: string, scope: ContextVariableScope): Promise<ContextVariableValue | null>;
  /**
   * Each variable's most specific stored value on the ladder (`scopes`, most specific first), keyed
   * by variable id, in one read for the whole turn. A variable with no value is absent.
   */
  readMostSpecificValues(variableIds: readonly string[], scopes: readonly ContextVariableScope[]): Promise<ReadonlyMap<string, ContextVariableValue>>;
  upsertValue(variableId: string, scope: ContextVariableScope, data: unknown, writtenBy: ContextValueWriter): Promise<ContextVariableValue | null>;
}

/** Turn-time read surface exposed to chat; resolution owns its backing reads. */
export interface ContextVariableResolutionReaderPort {
  resolveForAgent(workspaceId: string, agentId: string, scopes: ContextVariableScope[]): Promise<ResolvedVariableInput[]>;
  resolveForEnablements(
    workspaceId: string,
    agentId: string,
    enablements: readonly AgentContextVariableEnablement[],
    scopes: ContextVariableScope[],
    /** The skills the conversation runs (its release's), which resolver skills are read from. */
    conversationSkills?: ConversationSkillSet,
  ): Promise<ResolvedVariableInput[]>;
}

/** Read surface required by routine authoring to inspect agent enablements. */
export interface ContextVariableEnablementReaderPort {
  listByAgent(workspaceId: string, agentId: string): Promise<AgentContextVariableEnablement[]>;
}
