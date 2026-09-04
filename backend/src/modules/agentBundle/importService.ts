import { badRequest } from "../../shared/domain/errors.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { AGENT_CONFIG_SCHEMA_VERSION } from "../agents/public.js";
import {
  AGENT_BUNDLE_SCHEMA_VERSION,
  type AgentBundle,
  type AgentBundleImportResult,
  type AgentBundleSkill,
  type AgentBundleUnresolvedReference,
} from "./domain.js";
import { projectAgentConfigForImport } from "./importProjection.js";
import type {
  AgentBundleAgentWriterPort,
  AgentBundleContextVariableWriterPort,
  AgentBundleDirectiveWriterPort,
  AgentBundleRoutineWriterPort,
  AgentBundleSkillWriterPort,
} from "./ports.js";

export interface AgentBundleImportServiceOptions {
  agents: AgentBundleAgentWriterPort;
  logger?: AppLogger;
  directives: AgentBundleDirectiveWriterPort;
  skills: AgentBundleSkillWriterPort;
  contextVariables: AgentBundleContextVariableWriterPort;
  routines: AgentBundleRoutineWriterPort;
}

/**
 * Imports a bundle as a NEW agent.
 *
 * Import-into-existing is deliberately not offered: it is a merge, and a merge
 * needs a collision policy (overwrite? keep both? by name or by id?) that the
 * spec left open. Creating is unambiguous, and a new agent is also what makes the
 * failure path safe — see the compensating delete below.
 *
 * Order is load-bearing. Skills exist before context variables (an enablement's
 * resolver is a skill) and before routines (a tool step names a skill, and publish
 * validation checks that name against the agent's skills).
 */
export class AgentBundleImportService {
  constructor(private readonly options: AgentBundleImportServiceOptions) {}

  async import(workspaceId: string, bundle: AgentBundle): Promise<AgentBundleImportResult> {
    assertSupportedVersions(bundle);

    const projection = projectAgentConfigForImport(bundle.agent);
    const unresolved: AgentBundleUnresolvedReference[] = [...projection.unresolved];

    const { agentId } = await this.options.agents.create(workspaceId, projection.input);

    try {
      // Skills first: a directive's `binding.skillName` and a routine's `toolRef`
      // are both validated against the agent's skills, and an enablement's resolver
      // is one. Everything that names a skill has to come after the skills exist.
      const importedSkillNames = await this.importSkills(
        workspaceId,
        agentId,
        bundle.agentSkills ?? [],
        unresolved,
      );
      await this.importDirectives(
        workspaceId,
        agentId,
        bundle.agent.authoredDirectives ?? [],
        unresolved,
      );
      await this.importContextVariables(
        workspaceId,
        agentId,
        bundle.contextVariables ?? [],
        importedSkillNames,
        unresolved,
      );
      await this.importRoutines(workspaceId, agentId, bundle.routines ?? [], unresolved);
    } catch (error) {
      // Compensation, not a transaction. A crash between the create and this
      // delete leaves a partial agent; that is the documented cost of not
      // threading one transaction through four modules' services.
      try {
        await this.options.agents.delete(workspaceId, agentId);
      } catch (compensationError) {
        // The worse of the two failures: the operator now has a half-built agent
        // in their workspace and no reason for it. Name the row so support can
        // find it, because nothing else will point at it.
        this.options.logger?.error({
          workspaceId,
          orphanedAgentId: agentId,
          reason: compensationError instanceof Error ? compensationError.message : String(compensationError),
        }, "agent bundle import failed and its partially created agent could not be removed");
      }
      throw error;
    }

    // Counts only: a bundle holds the agent's instruction and every directive's
    // text, none of which belongs in a log line.
    this.options.logger?.info({
      workspaceId,
      agentId,
      routineCount: bundle.routines?.length ?? 0,
      skillCount: bundle.agentSkills?.length ?? 0,
      unresolvedCount: unresolved.length,
    }, "agent bundle imported");

    return { agentId, unresolved };
  }

  /**
   * A directive is pure authored behavior, so a failure to write one is normally a
   * bug and stays fatal. The one expected failure is a binding: the directive
   * service rejects a binding whose skill is missing or disabled, and import
   * disables exactly those skills whose connection did not travel. Retrying such a
   * directive disabled keeps the operator's authored text — the service skips
   * binding validation for a disabled directive, which is what makes the retry
   * meaningful rather than a second guess at its rules.
   */
  private async importDirectives(
    workspaceId: string,
    agentId: string,
    directives: readonly unknown[],
    unresolved: AgentBundleUnresolvedReference[],
  ): Promise<void> {
    for (const directive of directives) {
      const named = directive as { name?: string; binding?: unknown };
      try {
        await this.options.directives.create(workspaceId, agentId, directive);
        continue;
      } catch (error) {
        if (!named.binding) {
          throw error;
        }
        await this.options.directives.create(workspaceId, agentId, {
          ...(directive as Record<string, unknown>),
          enabled: false,
        });
        unresolved.push({
          kind: "directive_binding_unbound",
          element: `directive:${named.name ?? "unnamed"}`,
          detail: `"${named.name ?? "This directive"}" is bound to a skill that did not survive the import, so it arrives switched off: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  private async importSkills(
    workspaceId: string,
    agentId: string,
    skills: readonly AgentBundleSkill[],
    unresolved: AgentBundleUnresolvedReference[],
  ): Promise<Set<string>> {
    const imported = new Set<string>();

    for (const skill of skills) {
      if (!this.options.skills.hasCapability(skill.capability)) {
        // Not a failure of the bundle: a deployment may simply not register this
        // capability. Skipping it and saying so beats failing the whole import.
        unresolved.push({
          kind: "skill_capability_unknown",
          element: `skill:${skill.name}`,
          detail: `No capability "${skill.capability}" is available in this deployment, so the skill was not created. Anything referencing it stays unbound.`,
        });
        continue;
      }

      const needsTarget = skill.target.id !== null;
      try {
        await this.options.skills.create(workspaceId, agentId, {
          ...skill,
          // A skill whose connection did not travel must not answer with a target it
          // does not have. It imports disabled and the operator re-binds it.
          enabled: skill.enabled && !needsTarget,
          target: { kind: skill.target.kind, id: null },
        });
        imported.add(skill.name);
      } catch (error) {
        // A capability that requires a bound target rejects a null one. That is the
        // expected shape of "this connection did not travel", not a broken import —
        // aborting here would mean an agent with one webhook skill could never be
        // imported at all.
        unresolved.push({
          kind: "skill_target_unbound",
          element: `skill:${skill.name}`,
          detail: `"${skill.name}" needs a ${skill.target.kind ?? "connection"} in this workspace before it can be created: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (needsTarget) {
        unresolved.push({
          kind: "skill_target_unbound",
          element: `skill:${skill.name}`,
          detail: `Bind "${skill.name}" to a ${skill.target.kind ?? "connection"} in this workspace, then enable it.`,
        });
      }

      if (skill.omittedConfigKeys?.length) {
        unresolved.push({
          kind: "skill_config_not_portable",
          element: `skill:${skill.name}`,
          detail: `The source agent set ${skill.omittedConfigKeys.join(", ")} on "${skill.name}". Those values stay in their own workspace — re-enter them here.`,
        });
      }
    }

    return imported;
  }

  private async importContextVariables(
    workspaceId: string,
    agentId: string,
    enablements: readonly AgentBundle["contextVariables"][number][],
    importedSkillNames: ReadonlySet<string>,
    unresolved: AgentBundleUnresolvedReference[],
  ): Promise<void> {
    for (const enablement of enablements) {
      const variableId = await this.options.contextVariables.findVariableIdByName(
        workspaceId,
        enablement.variableName,
      );
      if (!variableId) {
        unresolved.push({
          kind: "context_variable_missing",
          element: `contextVariable:${enablement.variableName}`,
          detail: `No context variable named "${enablement.variableName}" exists in this workspace. Create it, then enable it on the agent.`,
        });
        continue;
      }

      let resolverSkillId: string | null = null;
      if (enablement.source === "resolver") {
        const name = enablement.resolverSkillName;
        resolverSkillId = name && importedSkillNames.has(name)
          ? await this.options.contextVariables.findSkillIdByName(workspaceId, agentId, name)
          : null;

        if (!resolverSkillId) {
          // A resolver-sourced enablement is invalid without its skill (the table's
          // own CHECK enforces it), so this one cannot be written at all.
          unresolved.push({
            kind: "resolver_skill_missing",
            element: `contextVariable:${enablement.variableName}`,
            detail: `"${enablement.variableName}" is resolved by the skill "${name ?? "unknown"}", which is not available on the imported agent. Re-enable the variable once that skill exists.`,
          });
          continue;
        }
      }

      await this.options.contextVariables.enable(workspaceId, agentId, {
        variableId,
        source: enablement.source,
        resolverSkillId,
        maxAgeSeconds: enablement.maxAgeSeconds,
        resolverTimeoutMs: enablement.resolverTimeoutMs,
        surfacing: enablement.surfacing,
        enabled: enablement.enabled,
      });
    }
  }

  private async importRoutines(
    workspaceId: string,
    agentId: string,
    routines: readonly AgentBundle["routines"][number][],
    unresolved: AgentBundleUnresolvedReference[],
  ): Promise<void> {
    for (const routine of routines) {
      let routineId: string;
      try {
        ({ routineId } = await this.options.routines.createDraft(
          workspaceId,
          agentId,
          routine.definition,
        ));
      } catch (error) {
        unresolved.push({
          kind: "routine_invalid",
          element: `routine:${routine.name}`,
          detail: `Could not be created: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      const outcome = await this.options.routines.publish(workspaceId, agentId, routineId);
      if (!outcome.published) {
        // The routine is kept as a draft rather than deleted: the operator can see
        // it, read the validator's diagnostics, and fix the binding. Dropping it
        // would lose authored work to a missing skill.
        unresolved.push({
          kind: "routine_invalid",
          element: `routine:${routine.name}`,
          detail: `Imported as a draft — publishing was rejected: ${outcome.reason}`,
        });
      }
    }
  }
}

/**
 * Versions are declared and checked, never guessed. A bundle written against a
 * future schema is rejected rather than partially understood.
 */
const assertSupportedVersions = (bundle: AgentBundle): void => {
  if (bundle.bundleVersion !== AGENT_BUNDLE_SCHEMA_VERSION) {
    throw badRequest(
      `Unsupported bundle version ${String(bundle.bundleVersion)}; this deployment reads version ${AGENT_BUNDLE_SCHEMA_VERSION}.`,
    );
  }
  if (bundle.agent?.schemaVersion !== AGENT_CONFIG_SCHEMA_VERSION) {
    throw badRequest(
      `Unsupported agent config version ${String(bundle.agent?.schemaVersion)}; this deployment reads version ${AGENT_CONFIG_SCHEMA_VERSION}.`,
    );
  }
};
