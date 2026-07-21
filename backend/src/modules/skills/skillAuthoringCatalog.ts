import {
  agentSkillToAuthoringDescriptor,
  externalSkillToAuthoringDescriptor,
  skillCatalogEntryToAuthoringDescriptor,
  type ExternalSkillAuthoringDescriptorSource,
  type SkillAuthoringDescriptor,
  type SkillCatalogDescriptorSource,
} from "./authoringDescriptor.js";
import type { AgentSkillRepositoryPort, AgentSkillSpine } from "../agentSkills/public.js";
import type { SkillAvailability } from "./domain.js";
import type { SkillCapabilityRegistry } from "./capabilityRegistry.js";
import { isRoutineAuthoringBuiltInSkill } from "./routineAuthoringPolicy.js";

export interface SkillAuthoringCatalogContext {
  workspaceId: string;
  agentId: string;
  accountId?: string;
  userId?: string;
}

export interface SkillAuthoringCatalog {
  listForAgent(context: SkillAuthoringCatalogContext): Promise<SkillAuthoringDescriptor[]>;
  getForAgent(
    context: SkillAuthoringCatalogContext,
    skillName: string,
  ): Promise<SkillAuthoringDescriptor | null>;
}

interface SkillCatalogAuthoringSourceEntry extends SkillCatalogDescriptorSource {
  availability?: SkillAvailability;
}

interface SkillCatalogAuthoringSource {
  list(context: Omit<SkillAuthoringCatalogContext, "agentId">): Promise<{
    skills: SkillCatalogAuthoringSourceEntry[];
  }>;
}

interface ExternalSkillAuthoringSource extends ExternalSkillAuthoringDescriptorSource {
  enabled?: boolean;
}

interface ExternalSkillAuthoringListSource {
  list(agentId: string): Promise<ExternalSkillAuthoringSource[]>;
}

interface SkillAuthoringCatalogLogger {
  warn(...args: unknown[]): void;
}

export class SkillAuthoringCatalogService implements SkillAuthoringCatalog {
  constructor(private readonly sources: {
    skillCatalog: SkillCatalogAuthoringSource;
    externalSkills: ExternalSkillAuthoringListSource;
    agentSkills?: Pick<AgentSkillRepositoryPort, "listByAgent">;
    capabilities?: SkillCapabilityRegistry;
    logger?: SkillAuthoringCatalogLogger;
  }) {}

  async listForAgent(context: SkillAuthoringCatalogContext): Promise<SkillAuthoringDescriptor[]> {
    const skillCatalogContext = {
      workspaceId: context.workspaceId,
      ...(context.accountId ? { accountId: context.accountId } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
    };
    // Each source degrades independently: a failure fetching external skills (e.g.
    // a missing table) must not blank the built-in/system skills, which do not
    // depend on it. We surface the partial catalog and log the failed source.
    const [catalogResult, externalResult, agentSkillsResult] = await Promise.allSettled([
      this.sources.skillCatalog.list(skillCatalogContext),
      this.sources.externalSkills.list(context.agentId),
      this.sources.agentSkills?.listByAgent(context.workspaceId, context.agentId) ?? Promise.resolve([]),
    ]);

    const systemDescriptors = catalogResult.status === "fulfilled"
      ? catalogResult.value.skills
        .filter((entry) => (entry.availability?.state ?? "available") === "available")
        .filter(isRoutineAuthoringBuiltInSkill)
        .map(skillCatalogEntryToAuthoringDescriptor)
      : this.warnSourceFailed("system_catalog", context, catalogResult.reason);
    const agentSkillDescriptors = agentSkillsResult.status === "fulfilled"
      ? this.agentSkillDescriptors(agentSkillsResult.value)
      : this.warnSourceFailed("agent_skills", context, agentSkillsResult.reason);
    const agentSkillNames = new Set(agentSkillDescriptors.map((descriptor) => descriptor.skillName));
    const externalDescriptors = externalResult.status === "fulfilled"
      ? externalResult.value
        .filter((skill) => skill.enabled ?? true)
        .filter((skill) => !agentSkillNames.has(skill.skillName))
        .map(externalSkillToAuthoringDescriptor)
      : this.warnSourceFailed("external_skills", context, externalResult.reason);

    return [...systemDescriptors, ...agentSkillDescriptors, ...externalDescriptors];
  }

  private agentSkillDescriptors(skills: AgentSkillSpine[]): SkillAuthoringDescriptor[] {
    if (!this.sources.capabilities) {
      return [];
    }
    return skills
      .filter((skill) => skill.kind !== "external_mcp")
      .filter((skill) => skill.enabled && skill.invocationMode === "routine_named")
      .flatMap((skill) => {
        const capability = this.sources.capabilities?.getByStoredKind(skill.kind);
        return capability && capability.supportedInvocationModes.includes("routine_named")
          ? [agentSkillToAuthoringDescriptor(skill, capability)]
          : [];
      });
  }

  private warnSourceFailed(
    source: "system_catalog" | "external_skills" | "agent_skills",
    context: SkillAuthoringCatalogContext,
    reason: unknown,
  ): never[] {
    this.sources.logger?.warn(
      { source, agentId: context.agentId, workspaceId: context.workspaceId, err: reason },
      "skill authoring catalog source failed; returning partial catalog",
    );
    return [];
  }

  async getForAgent(
    context: SkillAuthoringCatalogContext,
    skillName: string,
  ): Promise<SkillAuthoringDescriptor | null> {
    const descriptors = await this.listForAgent(context);
    return descriptors.find((descriptor) => descriptor.skillName === skillName) ?? null;
  }
}
