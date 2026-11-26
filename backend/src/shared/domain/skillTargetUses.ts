/**
 * Which agent skills and routine exports use a workspace-owned target: an API connection, an MCP
 * connection, a webhook destination, a customer email connection or a Slack installation. A
 * conversation runs the skill rows and routines its agent's published release froze, not the
 * draft's (`conversationSkills.ts`), so a target stays in use while the draft has a skill on it and
 * also while the published release still runs one, after the draft moved that skill elsewhere or
 * deleted it. A webhook destination is also held by a routine's completion export, on the same
 * draft-versus-release terms.
 *
 * The contract lives here, below the modules: each module that owns a target refuses its delete
 * through it, without knowing how agents keep drafts and releases. The agentSkills module implements
 * the skill reader over the database's one answer to the question, which the targets' delete
 * triggers refuse on too, and composition wires it.
 */

import { AppError } from "./errors.js";

export type SkillTargetType =
  | "api_connection"
  | "mcp_connection"
  | "webhook_destination"
  | "customer_email_connection"
  | "slack_installation";

/** Where an agent holds a target: in its draft, in its published release, or both. */
interface AgentTargetUse {
  readonly agentId: string;
  readonly agentName: string;
  /** The draft holds the target: deleting or retargeting what holds it frees it. */
  readonly inDraft: boolean;
  /** The published release holds it: only publishing a draft without it frees it. */
  readonly inPublishedRelease: boolean;
}

/** One skill on the target, by agent. */
export interface SkillTargetUse extends AgentTargetUse {
  readonly skillName: string;
}

/** One routine whose completion export delivers to a webhook destination, by agent. */
export interface RoutineExportUse extends AgentTargetUse {
  readonly routineName: string;
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

const quotedList = (values: readonly string[]): string => values.map(quoted).join(", ");

/** What holds a target and how to say so: the noun, the remedy that frees the draft, the release verb. */
interface HolderKind {
  readonly noun: string;
  /** How the draft lets go of `count` holders, as a sentence fragment. */
  readonly draftRemedy: (count: number) => string;
  /** What the published release does with the target, ending before the holder names. */
  readonly releaseVerb: string;
  /** Closes the release clause after the holder names. */
  readonly releaseTail: string;
}

const SKILL_KIND: HolderKind = {
  noun: "skill",
  draftRemedy: (count) => `delete or retarget ${count === 1 ? "that skill" : "those skills"}`,
  releaseVerb: "uses",
  releaseTail: "",
};

const ROUTINE_KIND: HolderKind = {
  noun: "routine",
  draftRemedy: (count) => `point ${count === 1 ? "its export" : "their exports"} elsewhere or turn ${count === 1 ? "it" : "them"} off`,
  releaseVerb: "exports",
  releaseTail: " to it",
};

const KINDS = [SKILL_KIND, ROUTINE_KIND];

interface Holder extends AgentTargetUse {
  readonly kind: HolderKind;
  readonly name: string;
}

const holders = (skills: readonly SkillTargetUse[], routines: readonly RoutineExportUse[]): Holder[] => [
  ...skills.map((use) => ({ ...use, kind: SKILL_KIND, name: use.skillName })),
  ...routines.map((use) => ({ ...use, kind: ROUTINE_KIND, name: use.routineName })),
];

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The draft holders, and after them the agents to publish once they are gone. */
const describeDraftHolders = (inDraft: readonly Holder[]): string | null => {
  if (inDraft.length === 0) return null;
  const named = inDraft.map((use) => `${use.kind.noun} ${quoted(use.name)} on agent ${quoted(use.agentName)}`);
  const remedies = KINDS
    .map((kind) => ({ kind, count: inDraft.filter((use) => use.kind === kind).length }))
    .filter(({ count }) => count > 0)
    .map(({ kind, count }) => kind.draftRemedy(count));
  const toPublish = [...new Set(inDraft.filter((use) => use.inPublishedRelease).map((use) => use.agentName))];
  const thenPublish = toPublish.length === 0
    ? " first"
    : `, then publish ${toPublish.length === 1 ? "agent" : "agents"} ${quotedList(toPublish)}`;
  return `Used by ${named.join(", ")}. ${capitalized(remedies.join(" and "))}${thenPublish}.`;
};

/** What an agent's published release still does with the target, by holder kind. */
const describeReleaseClauses = (held: readonly Holder[]): string =>
  KINDS
    .map((kind) => ({ kind, names: held.filter((use) => use.kind === kind).map((use) => use.name) }))
    .filter(({ names }) => names.length > 0)
    .map(({ kind, names }) => `${kind.releaseVerb} ${kind.noun}${names.length === 1 ? "" : "s"} ${quotedList(names)}${kind.releaseTail}`)
    .join(" and ");

const describeHolders = (all: readonly Holder[]): string => {
  const inDraft = all.filter((use) => use.inDraft);
  const sentences = [describeDraftHolders(inDraft)].filter((sentence) => sentence !== null);
  const publishedAfterDraft = new Set(inDraft.filter((use) => use.inPublishedRelease).map((use) => use.agentId));
  const releasedByAgent = new Map<string, { agentName: string; held: Holder[] }>();
  for (const use of all) {
    if (use.inDraft || !use.inPublishedRelease) continue;
    const agent = releasedByAgent.get(use.agentId) ?? { agentName: use.agentName, held: [] };
    agent.held.push(use);
    releasedByAgent.set(use.agentId, agent);
  }
  for (const [agentId, { agentName, held }] of releasedByAgent) {
    const clauses = describeReleaseClauses(held);
    sentences.push(publishedAfterDraft.has(agentId)
      ? `The published version of agent ${quoted(agentName)} also still ${clauses}.`
      : `The published version of agent ${quoted(agentName)} still ${clauses}. Publish agent ${quoted(agentName)} first.`);
  }
  return sentences.join(" ");
};

/**
 * Why a target held by skills and routine exports cannot be deleted yet, for the operator: the
 * draft holders to delete, retarget or turn off, and the agents whose published version still holds
 * it and needs publishing. One message covers both, so an agent is told to publish once. An agent
 * the draft sentence already says to publish is not told to again.
 */
const describeTargetUses = (
  skillUses: readonly SkillTargetUse[],
  routineUses: readonly RoutineExportUse[] = [],
): string => describeHolders(holders(skillUses, routineUses));

export const describeSkillTargetUses = (uses: readonly SkillTargetUse[]): string => describeTargetUses(uses);

/**
 * The 409 a target's delete answers while skills use it, under the kind's own error code: the
 * message names the skills and what frees the target. `otherUses` is a sentence naming anything
 * else that holds the target, or standing in for uses the caller may not see.
 */
export const skillTargetInUseError = (input: {
  code: string;
  targetLabel: string;
  uses: readonly SkillTargetUse[];
  /** Routine exports that deliver to the target, described together with the skills. */
  routineUses?: readonly RoutineExportUse[];
  otherUses?: string;
  details?: Record<string, unknown>;
}): AppError =>
  new AppError(
    409,
    input.code,
    [`${input.targetLabel} is in use.`, input.otherUses, describeTargetUses(input.uses, input.routineUses)]
      .filter((sentence) => sentence !== undefined && sentence.length > 0)
      .join(" "),
    input.details,
  );
