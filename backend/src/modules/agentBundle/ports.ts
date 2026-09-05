import type { AgentInput, ConversationAgent, InternalAgentExternalSkillsConfig } from "../agents/public.js";
import type { AgentSkillInvocationMode } from "../agentSkills/public.js";
import type { ContextVariableSource } from "../context-variables/public.js";
import type { ContextVariableSurfacing } from "../context-variables/public.js";
import type { RoutineDefinition, RoutineDefinitionDraftInput } from "../routines/public.js";
import type {
  AgentBundleImportFailureCode,
  AgentBundleImportRecord,
  AgentBundleImportResult,
  AgentBundleSkill,
} from "./domain.js";

/**
 * Narrow ports, one per collection the bundle composes. The module depends on
 * these rather than on the concrete services so composition owns the adapting and
 * a test can supply a fake without standing up four modules.
 */

export interface AgentBundleAgentReaderPort {
  load(workspaceId: string, agentId: string): Promise<ConversationAgent | null>;
}

/**
 * External skills are already projected for portability by the agents module; the
 * bundle only has to hand the serializer the same context every other
 * `AgentConfig` producer does.
 */
export interface AgentBundleExternalSkillsReaderPort {
  load(workspaceId: string, agentId: string): Promise<InternalAgentExternalSkillsConfig | null>;
}

export interface AgentBundleRoutineReaderPort {
  listByAgent(workspaceId: string, agentId: string): Promise<RoutineDefinition[]>;
}

/**
 * The enablement as stored, plus the names its ids resolve to. Reading the name
 * alongside the id is the reader's job — the bundle must never hold either id, and
 * a second round-trip per row to look them up would be the reader's work done
 * twice.
 */
export interface AgentBundleContextVariableRecord {
  variableId: string;
  variableName: string;
  source: ContextVariableSource;
  resolverSkillId: string | null;
  resolverSkillName: string | null;
  maxAgeSeconds: number | null;
  resolverTimeoutMs: number | null;
  surfacing: ContextVariableSurfacing;
  enabled: boolean;
}

export interface AgentBundleContextVariableReaderPort {
  listByAgent(workspaceId: string, agentId: string): Promise<AgentBundleContextVariableRecord[]>;
}

export interface AgentBundleAgentSkillRecord {
  name: string;
  capability: string;
  invocationMode: AgentSkillInvocationMode;
  enabled: boolean;
  config: Record<string, unknown>;
  target: { kind: string | null; id: string | null };
}

export interface AgentBundleAgentSkillReaderPort {
  listByAgent(workspaceId: string, agentId: string): Promise<AgentBundleAgentSkillRecord[]>;
}

/**
 * Which of a capability's settings fields may leave the workspace. Default is
 * "none": a capability author adding a field must opt it in, because
 * `agent_skills.config` is where a webhook URL or a recipient list lives.
 */
export interface AgentBundleSkillConfigPortabilityPort {
  portableFieldKeys(capability: string): Set<string>;
  /**
   * Every settings key the capability declares. Export needs both sets so it can
   * name what it left behind rather than just omitting it.
   */
  settingsFieldKeys(capability: string): Set<string>;
}

// ─── Write side ──────────────────────────────────────────────────────────────

export interface AgentBundleAgentWriterPort {
  create(workspaceId: string, input: AgentInput): Promise<{ agentId: string }>;
  /**
   * Compensation for a part-way failure. Import spans four modules' services and
   * a single transaction across them would invert this module's dependency
   * direction, so a failure deletes the agent it created instead — every child
   * table cascades on `agents`.
   */
  delete(workspaceId: string, agentId: string): Promise<void>;
}

export interface AgentBundleDirectiveWriterPort {
  create(workspaceId: string, agentId: string, directive: unknown): Promise<void>;
}

export interface AgentBundleSkillWriterPort {
  /** Resolves a capability id to its descriptor, or null when unknown here. */
  hasCapability(capability: string): boolean;
  create(workspaceId: string, agentId: string, skill: AgentBundleSkill): Promise<void>;
}

export interface AgentBundleContextVariableWriterPort {
  findVariableIdByName(workspaceId: string, name: string): Promise<string | null>;
  findSkillIdByName(workspaceId: string, agentId: string, name: string): Promise<string | null>;
  enable(workspaceId: string, agentId: string, enablement: {
    variableId: string;
    source: ContextVariableSource;
    resolverSkillId: string | null;
    maxAgeSeconds: number | null;
    resolverTimeoutMs: number | null;
    surfacing: ContextVariableSurfacing;
    enabled: boolean;
  }): Promise<void>;
}

/**
 * `publish` returns its outcome rather than throwing: the routine service treats a
 * validation rejection as a result, not an error, and an adapter that converted
 * one into an exception would make a normal outcome indistinguishable from an
 * infrastructure failure.
 */
export type AgentBundleRoutinePublishOutcome =
  | { published: true }
  | { published: false; reason: string };

export interface AgentBundleRoutineWriterPort {
  createDraft(
    workspaceId: string,
    agentId: string,
    definition: RoutineDefinitionDraftInput,
  ): Promise<{ routineId: string }>;
  publish(
    workspaceId: string,
    agentId: string,
    routineId: string,
  ): Promise<AgentBundleRoutinePublishOutcome>;
}

export interface AgentBundleImportRepositoryPort {
  createOrGet(input: {
    workspaceId: string;
    actorAccountId: string | null;
    idempotencyKey: string | null;
  }): Promise<
    | { status: "created"; job: AgentBundleImportRecord }
    | { status: "existing"; job: AgentBundleImportRecord }
  >;
  findById(workspaceId: string, importId: string): Promise<AgentBundleImportRecord | null>;
  markApplying(importId: string): Promise<void>;
  setCreatedAgent(importId: string, agentId: string): Promise<void>;
  markApplied(importId: string, result: AgentBundleImportResult): Promise<void>;
  markFailed(importId: string, failureCode: AgentBundleImportFailureCode, options: { terminal: boolean }): Promise<void>;
  claimStaleApplying(input: {
    ageSeconds: number;
    leaseSeconds: number;
    leaseToken: string;
    limit: number;
  }): Promise<AgentBundleImportRecord[]>;
  markCompensated(importId: string, leaseToken?: string): Promise<void>;
}
