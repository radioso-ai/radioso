import type { AgentSkillRepositoryPort } from "../../src/modules/agentSkills/public.js";
import type {
  SkillTargetType,
  SkillTargetUse,
  SkillTargetUseReader,
} from "../../src/shared/domain/skillTargetUses.js";

/** A reader for services whose test never deletes a target a skill uses. */
export const noSkillTargetUses: SkillTargetUseReader = {
  listSkillTargetUses: async () => [],
};

/** A reader that reports the same uses for every target. */
export const fixedSkillTargetUses = (uses: SkillTargetUse[]): SkillTargetUseReader => ({
  listSkillTargetUses: async () => uses.map((use) => ({ ...use })),
});

interface DraftSkillOnTarget {
  agentId: string;
  skillName: string;
}

type DraftSkillSource = (target: { workspaceId: string; targetId: string }) => Promise<DraftSkillOnTarget[]> | DraftSkillOnTarget[];

/**
 * Skill target uses over the test app's in-memory skill stores: the generic skills table and the
 * stores the per-kind skill routes write to. No in-memory release records skills, so every use is
 * the draft's, as for an agent whose release predates skill tracking.
 */
export class InMemorySkillTargetUses implements SkillTargetUseReader {
  constructor(private readonly options: {
    skills: Pick<AgentSkillRepositoryPort, "listByWorkspace">;
    perKind?: Partial<Record<SkillTargetType, DraftSkillSource>>;
    agentName: (workspaceId: string, agentId: string) => Promise<string>;
  }) {}

  async listSkillTargetUses(target: { workspaceId: string; targetType: SkillTargetType; targetId: string }): Promise<SkillTargetUse[]> {
    const generic = (await this.options.skills.listByWorkspace(target.workspaceId))
      .filter((skill) => skill.targetType === target.targetType && skill.targetId === target.targetId)
      .map((skill) => ({ agentId: skill.agentId, skillName: skill.skillName }));
    const kindSpecific = await (this.options.perKind?.[target.targetType]?.(target) ?? []);
    const unique = new Map([...generic, ...kindSpecific].map((use) => [`${use.agentId}:${use.skillName}`, use]));
    const uses = await Promise.all([...unique.values()].map(async (use) => ({
      ...use,
      agentName: await this.options.agentName(target.workspaceId, use.agentId),
      inDraft: true,
      inPublishedRelease: false,
    })));
    return uses.sort((left, right) =>
      left.agentName.localeCompare(right.agentName) || left.skillName.localeCompare(right.skillName));
  }
}
