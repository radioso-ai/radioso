import {
  externalSkillToAuthoringDescriptor,
  skillCatalogEntryToAuthoringDescriptor,
  type ExternalSkillAuthoringDescriptorSource,
  type SkillAuthoringDescriptor,
  type SkillCatalogDescriptorSource,
} from "./authoringDescriptor.js";
import type { SkillAvailability } from "./domain.js";
import { isRoutineDispatchableBuiltInSkill } from "./routineAuthoringPolicy.js";

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
    const [catalogResult, externalResult] = await Promise.allSettled([
      this.sources.skillCatalog.list(skillCatalogContext),
      this.sources.externalSkills.list(context.agentId),
    ]);

    const systemDescriptors = catalogResult.status === "fulfilled"
      ? catalogResult.value.skills
        .filter((entry) => (entry.availability?.state ?? "available") === "available")
        .filter(isRoutineDispatchableBuiltInSkill)
        .map(skillCatalogEntryToAuthoringDescriptor)
      : this.warnSourceFailed("system_catalog", context, catalogResult.reason);
    const externalDescriptors = externalResult.status === "fulfilled"
      ? externalResult.value
        .filter((skill) => skill.enabled ?? true)
        .map(externalSkillToAuthoringDescriptor)
      : this.warnSourceFailed("external_skills", context, externalResult.reason);

    return [...systemDescriptors, ...externalDescriptors];
  }

  private warnSourceFailed(
    source: "system_catalog" | "external_skills",
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
