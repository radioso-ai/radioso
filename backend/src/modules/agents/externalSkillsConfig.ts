import type { McpAuthMethod } from "../externalSkills/domain.js";
import type { AgentConfigRefPlaceholder, AgentConfigSecretPlaceholder } from "./agentConfigPlaceholders.js";
import { refPlaceholder, secretPlaceholder } from "./agentConfigPlaceholders.js";

/**
 * Export/import projection for an agent's External Skills via MCP (feature 087,
 * FR-015). Connections and skill definitions live in their own relational tables
 * (the data-of-record); this module renders them into the portable `AgentConfig`
 * bundle and resolves the import-time reference re-binding.
 *
 * Boundary: this module is the only place that knows how external-skill data
 * becomes export-ready config. It never sees plaintext secrets — credentials are
 * exported as `secret` placeholders and re-entered on import; the secret store
 * owns the actual tokens.
 */

/** Non-redacting source shape (real ids + `hasCredential`) drawn from the repos. */
export interface InternalMcpConnectionConfig {
  id: string;
  displayName: string;
  serverUrl: string;
  authMethod: McpAuthMethod;
  hasCredential: boolean;
}

export interface InternalExternalSkillConfig {
  skillName: string;
  connectionId: string;
  toolName: string;
  boundParams: Record<string, unknown>;
  exposedParams: Record<string, { description?: string; slotBinding?: string }>;
  declaredOutcomes: string[] | null;
  outcomeMap: Record<string, string> | null;
  enabled: boolean;
}

export interface InternalAgentExternalSkillsConfig {
  connections: InternalMcpConnectionConfig[];
  skills: InternalExternalSkillConfig[];
}

/** Portable (export-ready) connection: server address travels, the credential does not. */
export interface McpConnectionConfig {
  /** Within-bundle stable key for ref re-binding; NOT the database id. */
  key: string;
  displayName: string;
  serverUrl: string;
  authMethod: McpAuthMethod;
  /** `secret` placeholder when the source had a stored credential; re-entered on import. */
  credential: AgentConfigSecretPlaceholder | null;
}

export interface ExternalSkillConfig {
  skillName: string;
  /** `{ __ref: "mcpConnection", key }` — re-bound to a connection on import. */
  connection: AgentConfigRefPlaceholder;
  toolName: string;
  boundParams: Record<string, unknown>;
  exposedParams: Record<string, { description?: string; slotBinding?: string }>;
  declaredOutcomes: string[] | null;
  outcomeMap: Record<string, string> | null;
  enabled: boolean;
}

export interface AgentExternalSkillsConfig {
  connections: McpConnectionConfig[];
  skills: ExternalSkillConfig[];
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Deterministic within-bundle key for a connection, derived from export order. */
const connectionKey = (index: number): string => `connection-${index}`;

export const EMPTY_EXTERNAL_SKILLS: InternalAgentExternalSkillsConfig = { connections: [], skills: [] };

/**
 * Portability descriptors for the external-skills section, contributed to the
 * top-level `AgentConfig.portability` map. Array element paths use `[]`.
 */
export const EXTERNAL_SKILLS_PORTABILITY: readonly [path: string, portability: "ref" | "secret"][] = [
  ["externalSkills.connections[].credential", "secret"],
  ["externalSkills.skills[].connection", "ref"],
];

/**
 * Render the relational external-skill data into the portable bundle: connections
 * get a within-bundle key and a redacted credential; each skill's connection
 * reference becomes a keyed ref placeholder (never the absolute connection id).
 */
export const serializeExternalSkills = (
  source: InternalAgentExternalSkillsConfig,
): AgentExternalSkillsConfig => {
  const idToKey = new Map<string, string>();
  const connections = source.connections.map((connection, index) => {
    const key = connectionKey(index);
    idToKey.set(connection.id, key);
    return {
      key,
      displayName: connection.displayName,
      serverUrl: connection.serverUrl,
      authMethod: connection.authMethod,
      credential: connection.hasCredential ? secretPlaceholder() : null,
    } satisfies McpConnectionConfig;
  });

  const skills = source.skills.map((skill) => ({
    skillName: skill.skillName,
    connection: refPlaceholder("mcpConnection", idToKey.get(skill.connectionId)),
    toolName: skill.toolName,
    boundParams: cloneJson(skill.boundParams),
    exposedParams: cloneJson(skill.exposedParams),
    declaredOutcomes: skill.declaredOutcomes ? [...skill.declaredOutcomes] : null,
    outcomeMap: skill.outcomeMap ? cloneJson(skill.outcomeMap) : null,
    enabled: skill.enabled,
  } satisfies ExternalSkillConfig));

  return { connections, skills };
};

/** Internal (non-redacting) projection: real ids retained, secrets never carried. */
export const projectInternalExternalSkills = (
  source: InternalAgentExternalSkillsConfig,
): InternalAgentExternalSkillsConfig => cloneJson(source);

export interface ResolvedExternalSkillImport {
  skillName: string;
  connectionId: string;
  toolName: string;
  boundParams: Record<string, unknown>;
  exposedParams: Record<string, { description?: string; slotBinding?: string }>;
  declaredOutcomes: string[] | null;
  outcomeMap: Record<string, string> | null;
  enabled: boolean;
}

export interface ExternalSkillsRefResolution {
  /** Skills whose connection ref re-bound to a created connection id. */
  skills: ResolvedExternalSkillImport[];
  /** Skills dropped because their referenced connection was absent on import. */
  unresolved: Array<{ skillName: string; missingConnectionKey: string | null }>;
}

/**
 * Import-time reference re-binding (the open question from the agent-settings-as-data
 * direction): given the bundle and a map of within-bundle connection key -> newly
 * created connection id, re-bind each skill's connection ref. A skill whose
 * connection is absent is reported as `unresolved` and dropped — a skill cannot
 * exist without its connection (mirrors the ON DELETE RESTRICT data rule), so a
 * stub connection would be meaningless.
 */
export const resolveExternalSkillRefs = (
  config: AgentExternalSkillsConfig,
  connectionKeyToId: Map<string, string>,
): ExternalSkillsRefResolution => {
  const skills: ResolvedExternalSkillImport[] = [];
  const unresolved: Array<{ skillName: string; missingConnectionKey: string | null }> = [];

  for (const skill of config.skills) {
    const key = skill.connection.key ?? null;
    const connectionId = key ? connectionKeyToId.get(key) : undefined;
    if (!connectionId) {
      unresolved.push({ skillName: skill.skillName, missingConnectionKey: key });
      continue;
    }
    skills.push({
      skillName: skill.skillName,
      connectionId,
      toolName: skill.toolName,
      boundParams: cloneJson(skill.boundParams),
      exposedParams: cloneJson(skill.exposedParams),
      declaredOutcomes: skill.declaredOutcomes ? [...skill.declaredOutcomes] : null,
      outcomeMap: skill.outcomeMap ? cloneJson(skill.outcomeMap) : null,
      enabled: skill.enabled,
    });
  }

  return { skills, unresolved };
};
