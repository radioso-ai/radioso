import type {
  AgentConfig,
  AgentConfigPortability,
  AgentConfigRefPlaceholder,
} from "../agents/public.js";
import type { AgentSkillInvocationMode } from "../agentSkills/public.js";
import type { ContextVariableSource } from "../context-variables/public.js";
import type { ContextVariableSurfacing } from "../context-variables/public.js";
import type { RoutineDefinitionDraftInput } from "../routines/public.js";

/**
 * The portable unit of exchange for a whole agent.
 *
 * A bundle *composes* an `AgentConfig` rather than extending it. `AgentConfig`
 * has a second consumer — eval replay, which feeds `InternalAgentConfig` to
 * `materializeAgentFromConfig` to rebuild a `ConversationAgent`. Routines,
 * context-variable enablements and agent skills are not part of a
 * `ConversationAgent`, so folding them into `AgentConfig` would put fields into a
 * type whose other consumer must deliberately ignore them, and would grow every
 * `eval_snapshots.original_agent_config` row with data replay cannot use.
 */
export const AGENT_BUNDLE_SCHEMA_VERSION = 1;

/**
 * A published routine, stripped of the columns that identify it in one database.
 *
 * `definition` is the routine's draft-input shape — the same schema
 * `routineDefinitionDraftInputSchema` validates on create — because a
 * `RoutineDefinition` is already free of workspace-scoped references: a tool step
 * names its skill (`toolRef`), a slot names its context variable, and
 * `stableStepId` is routine-local. Nothing here needs re-keying on import.
 */
export interface AgentBundleRoutine {
  name: string;
  /** Source version, carried for provenance only; import always creates v1. */
  version: number;
  definition: RoutineDefinitionDraftInput;
}

/**
 * An enablement re-keyed to natural keys. The stored row points at
 * `variable_id` and `resolver_skill_id`; neither survives a workspace move, and
 * both have a stable name in the target workspace to resolve against.
 */
export interface AgentBundleContextVariable {
  variableName: string;
  source: ContextVariableSource;
  resolverSkillName: string | null;
  maxAgeSeconds: number | null;
  resolverTimeoutMs: number | null;
  surfacing: ContextVariableSurfacing;
  enabled: boolean;
}

/**
 * A skill's authored shape. `target` addresses a workspace connection that holds
 * credentials (a webhook destination, an MCP connection, a mailbox), so the id is
 * placeheld and the skill imports unbound — the caller is told which ones.
 * `config` carries only the fields a capability marked portable.
 */
export interface AgentBundleSkill {
  name: string;
  capability: string;
  invocationMode: AgentSkillInvocationMode;
  enabled: boolean;
  config: Record<string, unknown>;
  /**
   * Settings the source agent had a value for that the capability does not mark
   * portable. Only the key names travel, never the values — the same split the
   * capability registry already makes for what the copilot may read. Without this
   * the skill would import with partial configuration and nobody would be told.
   */
  omittedConfigKeys: string[];
  target: {
    kind: string | null;
    id: AgentConfigRefPlaceholder | null;
  };
}

export interface AgentBundle {
  bundleVersion: typeof AGENT_BUNDLE_SCHEMA_VERSION;
  /**
   * Portability of the bundle's own collections. The agent's fields keep their
   * own map at `agent.portability`; each producer owns the classification of what
   * it serialized.
   */
  portability: Record<string, AgentConfigPortability>;
  agent: AgentConfig;
  routines: AgentBundleRoutine[];
  contextVariables: AgentBundleContextVariable[];
  agentSkills: AgentBundleSkill[];
}

export const AGENT_BUNDLE_PORTABILITY: Record<string, AgentConfigPortability> = {
  agent: "portable",
  routines: "portable",
  contextVariables: "portable",
  agentSkills: "portable",
  "agentSkills[].config": "portable",
  "agentSkills[].omittedConfigKeys": "portable",
  "agentSkills[].target.id": "ref",
};

/**
 * Why a bundle element could not be fully applied to the target workspace.
 *
 * Every one of these is reported rather than silently dropped: a bundle that
 * imports quietly minus a skill binding is an agent that looks configured and
 * answers wrong.
 */
export type AgentBundleUnresolvedKind =
  /** The bundle names a context variable that does not exist in this workspace. */
  | "context_variable_missing"
  /** The enablement's resolver skill did not survive import, so it stays unbound. */
  | "resolver_skill_missing"
  /** The skill's connection target is a credential-bearing workspace row. */
  | "skill_target_unbound"
  /** No capability with this id is registered in this deployment. */
  | "skill_capability_unknown"
  /** The routine imported as a draft because publish validation rejected it. */
  | "routine_invalid"
  /** Selected document sources cannot be matched; scope imports empty, not "all". */
  | "document_source_unresolved"
  /** A surface whose token cannot travel; imported disabled so it cannot serve. */
  | "surface_credential_unbound"
  /** An external MCP connection reference; the skill imports without its server. */
  | "mcp_connection_unbound"
  /** Binary stored outside the database (the logo); not part of the bundle. */
  | "asset_not_portable"
  /** A skill setting whose value the capability keeps inside its own workspace. */
  | "skill_config_not_portable"
  /** A directive bound to a skill that did not survive import; kept, but disabled. */
  | "directive_binding_unbound";

export interface AgentBundleUnresolvedReference {
  kind: AgentBundleUnresolvedKind;
  /** The bundle element the caller must fix, named the way they authored it. */
  element: string;
  detail: string;
}

export interface AgentBundleImportResult {
  agentId: string;
  unresolved: AgentBundleUnresolvedReference[];
}
