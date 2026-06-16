import {
  externalSkillToAuthoringDescriptor,
  skillCatalogEntryToAuthoringDescriptor,
  type ExternalSkillAuthoringDescriptorSource,
  type SkillAuthoringDescriptor,
  type SkillCatalogDescriptorSource,
} from "./authoringDescriptor.js";
import type { SkillAvailability } from "./domain.js";

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

export class SkillAuthoringCatalogService implements SkillAuthoringCatalog {
  constructor(private readonly sources: {
    skillCatalog: SkillCatalogAuthoringSource;
    externalSkills: ExternalSkillAuthoringListSource;
  }) {}

  async listForAgent(context: SkillAuthoringCatalogContext): Promise<SkillAuthoringDescriptor[]> {
    const skillCatalogContext = {
      workspaceId: context.workspaceId,
      ...(context.accountId ? { accountId: context.accountId } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
    };
    const [catalog, externalSkills] = await Promise.all([
      this.sources.skillCatalog.list(skillCatalogContext),
      this.sources.externalSkills.list(context.agentId),
    ]);

    const systemDescriptors = catalog.skills
      .filter((entry) => (entry.availability?.state ?? "available") === "available")
      .map(skillCatalogEntryToAuthoringDescriptor);
    const externalDescriptors = externalSkills
      .filter((skill) => skill.enabled ?? true)
      .map(externalSkillToAuthoringDescriptor);

    return [...systemDescriptors, ...externalDescriptors];
  }

  async getForAgent(
    context: SkillAuthoringCatalogContext,
    skillName: string,
  ): Promise<SkillAuthoringDescriptor | null> {
    const descriptors = await this.listForAgent(context);
    return descriptors.find((descriptor) => descriptor.skillName === skillName) ?? null;
  }
}
