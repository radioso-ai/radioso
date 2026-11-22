/**
 * Which agent skills use a workspace-owned skill target: an API connection, an MCP connection, a
 * webhook destination, a customer email connection or a Slack installation. A conversation runs the
 * skill rows its agent's published release froze, not the draft's (`conversationSkills.ts`), so a
 * target stays in use while the draft has a skill on it and also while the published release still
 * runs one, after the draft moved that skill elsewhere or deleted it.
 *
 * The contract lives here, below the modules: each module that owns a target refuses its delete
 * through it, without knowing how agents keep drafts and releases. The agentSkills module implements
 * it over the database's one answer to the question, which the targets' delete triggers refuse on
 * too, and composition wires it.
 */

import { AppError } from "./errors.js";

export type SkillTargetType =
  | "api_connection"
  | "mcp_connection"
  | "webhook_destination"
  | "customer_email_connection"
  | "slack_installation";

/** One skill on the target, by agent: in the agent's draft, in its published release, or both. */
export interface SkillTargetUse {
  readonly agentId: string;
  readonly agentName: string;
  readonly skillName: string;
  /** The draft has the skill on the target: deleting or retargeting the skill frees it. */
  readonly inDraft: boolean;
  /** The published release runs the skill on the target: only publishing a draft without it frees it. */
  readonly inPublishedRelease: boolean;
}

export interface SkillTargetUseReader {
  /** Every skill on the target, ordered by agent name, then skill name. */
  listSkillTargetUses(target: {
    workspaceId: string;
    targetType: SkillTargetType;
    targetId: string;
  }): Promise<SkillTargetUse[]>;
}

const quoted = (value: string): string => `"${value}"`;

/**
 * Why a target in use cannot be deleted yet, for the operator: the draft skills to delete or
 * retarget, and the agents whose published version still runs a skill on it and needs publishing.
 */
export const describeSkillTargetUses = (uses: readonly SkillTargetUse[]): string => {
  const sentences: string[] = [];
  const inDraft = uses.filter((use) => use.inDraft);
  if (inDraft.length > 0) {
    const skills = inDraft.map((use) => `skill ${quoted(use.skillName)} on agent ${quoted(use.agentName)}`);
    sentences.push(`Used by ${skills.join(", ")}. Delete or retarget ${inDraft.length === 1 ? "that skill" : "those skills"} first.`);
  }
  const releasedByAgent = new Map<string, { agentName: string; skillNames: string[] }>();
  for (const use of uses) {
    if (use.inDraft || !use.inPublishedRelease) continue;
    const agent = releasedByAgent.get(use.agentId) ?? { agentName: use.agentName, skillNames: [] };
    agent.skillNames.push(use.skillName);
    releasedByAgent.set(use.agentId, agent);
  }
  for (const { agentName, skillNames } of releasedByAgent.values()) {
    sentences.push(
      `The published version of agent ${quoted(agentName)} still uses ${skillNames.length === 1 ? "skill" : "skills"} ` +
        `${skillNames.map(quoted).join(", ")}. Publish agent ${quoted(agentName)} first.`,
    );
  }
  return sentences.join(" ");
};

/**
 * The 409 a target's delete answers while skills use it, under the kind's own error code: the
 * message names the skills and what frees the target, and `details.skillUses` carries them.
 * `otherUses` is a sentence naming anything else that holds the target, such as routines.
 */
export const skillTargetInUseError = (input: {
  code: string;
  targetLabel: string;
  uses: readonly SkillTargetUse[];
  otherUses?: string;
  details?: Record<string, unknown>;
}): AppError =>
  new AppError(
    409,
    input.code,
    [`${input.targetLabel} is in use.`, input.otherUses, describeSkillTargetUses(input.uses)]
      .filter((sentence) => sentence !== undefined && sentence.length > 0)
      .join(" "),
    { ...input.details, skillUses: input.uses },
  );
