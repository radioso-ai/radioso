/**
 * The skills a conversation runs: the skill rows of the agent release it is pinned to (or, for a
 * private test, of the candidate it runs). A skill edit lands in the agent's draft and in the live
 * `agent_skills` row at once, so whatever runs a skill for a conversation (an executor, a routine,
 * a context resolver, a queued contact request) reads the row from this set rather than the table;
 * only workspace-owned things such as connections and credentials stay live.
 *
 * The contract lives here, below the modules, because the executors and resolvers that read it sit
 * on the far side of the agents/agentSkills module cycle. The agentSkills module implements the
 * resolution (`ConversationSkills`), and composition wires it.
 */

/** One skill as a release froze it: everything an executor reads to run it. */
export interface ConversationSkill {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly skillName: string;
  readonly kind: string;
  readonly invocationMode: string;
  readonly enabled: boolean;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly config?: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ConversationSkillSet = readonly ConversationSkill[];

/** What a kind's executor record is read from: one skill row, whichever kind and mode it has. */
export type ConversationSkillRow = Omit<ConversationSkill, "kind" | "invocationMode" | "targetType">;

/**
 * Why a skill was read from the live table instead of a conversation's set: the release predates
 * skill tracking, the work belongs to no pinned release, or a dispatch path carried no set.
 */
export type LiveSkillFallbackReason = "release_unrecorded" | "conversation_unpinned" | "not_threaded";

const CONTEXT_KEY = "conversationSkills";

/** The context entry that carries a conversation's skills on a skill invocation. */
export const withConversationSkills = (skills: ConversationSkillSet | undefined): Record<string, unknown> =>
  skills ? { [CONTEXT_KEY]: skills } : {};

/** The conversation's skills a skill invocation carries, when its caller threaded them. */
export const conversationSkillsOf = (context: Readonly<Record<string, unknown>> | undefined): ConversationSkillSet | undefined => {
  const skills = context?.[CONTEXT_KEY];
  return Array.isArray(skills) ? skills as ConversationSkillSet : undefined;
};
