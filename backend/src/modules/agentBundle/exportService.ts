import { notFound } from "../../shared/domain/errors.js";
import { refPlaceholder, serializeAgentConfig } from "../agents/public.js";
import type { RoutineDefinition } from "../routines/public.js";
import {
  AGENT_BUNDLE_PORTABILITY,
  AGENT_BUNDLE_SCHEMA_VERSION,
  type AgentBundle,
  type AgentBundleContextVariable,
  type AgentBundleRoutine,
  type AgentBundleSkill,
} from "./domain.js";
import type {
  AgentBundleAgentReaderPort,
  AgentBundleAgentSkillReaderPort,
  AgentBundleAgentSkillRecord,
  AgentBundleContextVariableReaderPort,
  AgentBundleContextVariableRecord,
  AgentBundleExternalSkillsReaderPort,
  AgentBundleRoutineReaderPort,
  AgentBundleSkillConfigPortabilityPort,
} from "./ports.js";

export interface AgentBundleExportServiceOptions {
  agents: AgentBundleAgentReaderPort;
  externalSkills: AgentBundleExternalSkillsReaderPort;
  routines: AgentBundleRoutineReaderPort;
  contextVariables: AgentBundleContextVariableReaderPort;
  agentSkills: AgentBundleAgentSkillReaderPort;
  skillConfigPortability: AgentBundleSkillConfigPortabilityPort;
}

/**
 * Columns that identify a routine row in one database. Stripping them by name
 * (rather than picking the fields to keep) means a new authored field on
 * `RoutineDefinition` travels by default — the failure mode of the alternative is
 * a field that silently stops being portable when someone adds it.
 */
const ROUTINE_IDENTITY_FIELDS = [
  "id",
  "agentId",
  "lineageId",
  "version",
  "status",
  "createdAt",
  "updatedAt",
] as const;

const stripRoutineIdentity = (routine: RoutineDefinition): AgentBundleRoutine["definition"] => {
  const portable = { ...routine } as Record<string, unknown>;
  for (const field of ROUTINE_IDENTITY_FIELDS) {
    delete portable[field];
  }
  return portable as AgentBundleRoutine["definition"];
};

/**
 * Reads a dotted key out of a config object. Capability settings fields are keyed
 * by path (`delivery.webhook.url`), so a portable-field filter has to walk.
 */
const readPath = (source: Record<string, unknown>, path: string): unknown => {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
};

const writePath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split(".");
  const last = segments.pop();
  if (!last) {
    return;
  }
  let cursor = target;
  for (const segment of segments) {
    const next = cursor[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[last] = value;
};

export class AgentBundleExportService {
  constructor(private readonly options: AgentBundleExportServiceOptions) {}

  async export(workspaceId: string, agentId: string): Promise<AgentBundle> {
    const agent = await this.options.agents.load(workspaceId, agentId);
    if (!agent) {
      throw notFound("Agent not found");
    }

    const [externalSkills, routines, contextVariables, agentSkills] = await Promise.all([
      this.options.externalSkills.load(workspaceId, agentId),
      this.options.routines.listByAgent(workspaceId, agentId),
      this.options.contextVariables.listByAgent(workspaceId, agentId),
      this.options.agentSkills.listByAgent(workspaceId, agentId),
    ]);

    return {
      bundleVersion: AGENT_BUNDLE_SCHEMA_VERSION,
      portability: { ...AGENT_BUNDLE_PORTABILITY },
      agent: serializeAgentConfig(agent, externalSkills ? { externalSkills } : {}),
      routines: this.serializeRoutines(routines),
      contextVariables: contextVariables.map(serializeContextVariable),
      agentSkills: agentSkills.map((skill) => this.serializeSkill(skill)),
    };
  }

  /**
   * Published only. A draft is work in progress the operator has not committed to
   * the agent's behavior, and `superseded`/`archived` are history — exporting them
   * would import behavior the source agent is not running.
   */
  private serializeRoutines(routines: readonly RoutineDefinition[]): AgentBundleRoutine[] {
    return routines
      .filter((routine) => routine.status === "published")
      .map((routine) => ({
        name: routine.name,
        version: routine.version,
        definition: stripRoutineIdentity(routine),
      }));
  }

  /**
   * Two passes, because a capability's declared `settingsFields` are not the whole
   * of what its `configSchema` accepts. `email`, for instance, declares only `mode`
   * while its schema carries the `boundInputs`/`exposedInputs` field routing an
   * operator authored. Exporting only the declared keys would drop that routing
   * with no signal at all — the exact silent loss this module exists to prevent.
   *
   * So: declared keys are carried when marked portable and named when not, and any
   * stored key nobody declared is named too. Undeclared means unjudged, and
   * unjudged never travels.
   */
  private serializeSkill(skill: AgentBundleAgentSkillRecord): AgentBundleSkill {
    const portableKeys = this.options.skillConfigPortability.portableFieldKeys(skill.capability);
    const declaredKeys = this.options.skillConfigPortability.settingsFieldKeys(skill.capability);
    const config: Record<string, unknown> = {};
    const omittedConfigKeys: string[] = [];

    // Shallowest path first, then alphabetical. `writePath` coerces a parent into an
    // object to reach a child, so an unordered walk over a capability declaring both
    // `delivery` and `delivery.webhook.url` would produce a different result run to
    // run. A capability should not declare a key that is a prefix of another; this
    // at least makes the outcome deterministic if one ever does.
    const orderedKeys = [...declaredKeys].sort((left, right) => {
      const depth = left.split(".").length - right.split(".").length;
      return depth !== 0 ? depth : left.localeCompare(right);
    });

    for (const key of orderedKeys) {
      const value = readPath(skill.config, key);
      if (value === undefined) {
        continue;
      }
      if (portableKeys.has(key)) {
        writePath(config, key, value);
      } else {
        // The key name, never the value: a name is already public in the
        // capability descriptor, and naming it is what lets import say what the
        // operator has to re-enter.
        omittedConfigKeys.push(key);
      }
    }

    for (const storedKey of Object.keys(skill.config ?? {}).sort()) {
      const isDeclared = declaredKeys.has(storedKey)
        || [...declaredKeys].some((declared) => declared.startsWith(`${storedKey}.`));
      if (!isDeclared) {
        omittedConfigKeys.push(storedKey);
      }
    }

    return {
      name: skill.name,
      capability: skill.capability,
      invocationMode: skill.invocationMode,
      enabled: skill.enabled,
      config,
      omittedConfigKeys,
      target: {
        kind: skill.target.kind,
        // The id addresses a workspace connection holding credentials. It never
        // travels; import re-binds by hand and the response says which skills are
        // waiting for one.
        id: skill.target.id === null ? null : refPlaceholder("agentSkillTarget"),
      },
    };
  }
}

const serializeContextVariable = (
  record: AgentBundleContextVariableRecord,
): AgentBundleContextVariable => ({
  variableName: record.variableName,
  source: record.source,
  resolverSkillName: record.resolverSkillName,
  maxAgeSeconds: record.maxAgeSeconds,
  resolverTimeoutMs: record.resolverTimeoutMs,
  surfacing: record.surfacing,
  enabled: record.enabled,
});
