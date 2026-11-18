import {
  conversationSkillsOf,
  type ConversationSkill,
  type ConversationSkillSet,
  type LiveSkillFallbackReason,
} from "../../shared/domain/conversationSkills.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { AgentSkillSpine } from "./domain.js";
import type { AgentSkillRepositoryPort } from "./repository.js";

/**
 * The release a stored conversation is pinned to, as far as its skills go: `null` when the
 * conversation is pinned to none, `agentSkills` absent when that release predates skill tracking.
 */
export interface ConversationReleaseSkillsReader {
  findConversationRelease(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<{ agentSkills?: ConversationSkillSet } | null>;
}

/**
 * Resolves the skills a conversation runs (see `shared/domain/conversationSkills.ts`): the skills
 * frozen into its release, or the live `agent_skills` table when that release recorded none, which
 * is what such a release served before skills were tracked.
 */
export class ConversationSkills {
  constructor(private readonly deps: {
    live: Pick<AgentSkillRepositoryPort, "listByAgent">;
    releases?: ConversationReleaseSkillsReader;
    onLiveFallback?: (reason: LiveSkillFallbackReason) => void;
  }) {}

  /** For a turn, whose agent was resolved against its release (`authoredAgentSkills`). */
  async forTurn<S extends ConversationSkill = ConversationSkill>(agent: {
    workspaceId: string;
    id: string;
    authoredAgentSkills?: readonly S[];
  }): Promise<readonly (S | AgentSkillSpine)[]> {
    if (agent.authoredAgentSkills) {
      return agent.authoredAgentSkills;
    }
    this.deps.onLiveFallback?.("release_unrecorded");
    return this.deps.live.listByAgent(agent.workspaceId, agent.id);
  }

  /** For work a stored conversation queued that runs outside its turn: a contact request, an export. */
  async forConversation(input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
  }): Promise<ConversationSkillSet> {
    const release = await this.deps.releases?.findConversationRelease({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
    }) ?? null;
    if (release?.agentSkills) {
      return release.agentSkills;
    }
    this.deps.onLiveFallback?.(release ? "release_unrecorded" : "conversation_unpinned");
    return this.deps.live.listByAgent(input.workspaceId, input.agentId);
  }

  /**
   * An executor's lookup of one enabled skill of `kind`, by name, scoped to the conversation the
   * invocation runs for: the row in the conversation's skills the invocation carries, mapped to the
   * executor's record; the live lookup when the invocation carries none.
   */
  scopedLookup<T>(input: {
    kind: string;
    fromSkill: (skill: ConversationSkill) => T;
    live: (lookup: { workspaceId: string; agentId: string; skillName: string }) => Promise<T | null>;
  }): (lookup: {
    workspaceId: string;
    agentId: string;
    skillName: string;
    context?: Readonly<Record<string, unknown>>;
  }) => Promise<T | null> {
    return async ({ context, ...lookup }) => {
      const skills = conversationSkillsOf(context);
      if (!skills) {
        this.deps.onLiveFallback?.("not_threaded");
        return input.live(lookup);
      }
      const skill = skills.find((candidate) =>
        candidate.kind === input.kind && candidate.skillName === lookup.skillName && candidate.enabled);
      return skill ? input.fromSkill(skill) : null;
    };
  }
}

/** Counts each live read of skills a conversation's release should have supplied, by reason only. */
export const countLiveSkillFallbacks = (
  metrics: Pick<MetricsRegistry, "incrementCounter"> | null | undefined,
) => (reason: LiveSkillFallbackReason): void => {
  metrics?.incrementCounter("agent_skill_live_reads_total", {
    help: "Skill reads that used the live agent_skills table instead of a conversation's release, by reason.",
    labels: { reason },
  });
};
