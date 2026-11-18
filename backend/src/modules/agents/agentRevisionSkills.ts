import { canonicalJson } from "../../shared/domain/canonicalContentHash.js";
import type { AgentRevisionSnapshot } from "./agentRevision.js";

type RevisionSkill = NonNullable<AgentRevisionSnapshot["agentSkills"]>[number];

/** One skill a release adds, removes or changes, named as the operator authored it. */
interface AgentRevisionSkillChange {
  readonly skillId: string;
  readonly skillName: string;
  readonly change: "added" | "removed" | "changed";
  /** For a changed skill: whether its settings (`config`) changed, which a redacted review cannot show. */
  readonly settingsChanged?: boolean;
  readonly before?: RevisionSkill;
  readonly after?: RevisionSkill;
}

/**
 * A skill as a review shows it, wherever it is shown (the publication review, the version history,
 * Ray's candidate reader): its settings are left out, since they can hold recipients, payloads and
 * tool settings; `configRedacted` says some were there.
 */
export const redactedRevisionSkill = (skill: RevisionSkill) => ({
  name: skill.skillName,
  kind: skill.kind,
  invocationMode: skill.invocationMode,
  enabled: skill.enabled,
  targetType: skill.targetType ?? null,
  targetId: skill.targetId ?? null,
  configRedacted: skill.config !== undefined,
});

const canonicalSettings = (skill: RevisionSkill): string =>
  canonicalJson(JSON.parse(JSON.stringify(skill.config ?? {})) as unknown);

/**
 * The skills a release serves, by id. The default-answer skill is left out: it carries the agent's
 * retrieval settings, which the agent record reads from the live skills table, so they apply
 * without publishing and a release neither serves nor changes them.
 */
const releasedSkills = (skills: ReadonlyArray<RevisionSkill>): ReadonlyMap<string, RevisionSkill> =>
  new Map(skills.filter((skill) => skill.invocationMode !== "default_answer").map((skill) => [skill.id, skill]));

/**
 * A skill as authored. Which agent and workspace hold the row, and when it was written, are left
 * out: a save that restores earlier content moves `updatedAt` without changing what visitors get.
 * `canonicalJson` fixes config key order, which depends on the writer and the JSONB round trip.
 */
const authoredSkill = (skill: RevisionSkill): string => canonicalJson(JSON.parse(JSON.stringify({
  skillName: skill.skillName,
  kind: skill.kind,
  invocationMode: skill.invocationMode,
  enabled: skill.enabled,
  targetType: skill.targetType ?? null,
  targetId: skill.targetId ?? null,
  config: skill.config ?? {},
})) as unknown);

/**
 * The skill changes publishing `candidate` makes over `base` (none, for a first release). This is
 * the one comparison behind the draft-dirty check, the publication review and the version history.
 *
 * A snapshot that records no skills predates skill tracking. Such a release serves the live skills
 * table, and every skill write keeps that table and the draft equal, so there is nothing to compare.
 */
export const diffAgentRevisionSkills = (
  base: Pick<AgentRevisionSnapshot, "agentSkills"> | null,
  candidate: Pick<AgentRevisionSnapshot, "agentSkills">,
): AgentRevisionSkillChange[] => {
  const baseSkills = base === null ? [] : base.agentSkills;
  if (baseSkills === undefined || candidate.agentSkills === undefined) return [];
  const before = releasedSkills(baseSkills);
  const after = releasedSkills(candidate.agentSkills);
  const changes: AgentRevisionSkillChange[] = [];
  for (const skillId of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(skillId);
    const next = after.get(skillId);
    if (!previous && next) changes.push({ skillId, skillName: next.skillName, change: "added", after: next });
    else if (previous && !next) changes.push({ skillId, skillName: previous.skillName, change: "removed", before: previous });
    else if (previous && next && authoredSkill(previous) !== authoredSkill(next)) {
      changes.push({
        skillId,
        skillName: next.skillName,
        change: "changed",
        settingsChanged: canonicalSettings(previous) !== canonicalSettings(next),
        before: previous,
        after: next,
      });
    }
  }
  return changes.sort((left, right) => left.skillName.localeCompare(right.skillName) || left.skillId.localeCompare(right.skillId));
};
