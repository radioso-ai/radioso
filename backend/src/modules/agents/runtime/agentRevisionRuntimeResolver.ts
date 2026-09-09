import { notFound } from "../../../shared/domain/errors.js";
import type { AgentRecord } from "../public.js";
import type { AgentRevision, AgentRevisionSnapshot } from "../agentRevision.js";
import type { AgentSkillSpine } from "../../agentSkills/public.js";

/**
 * Runtime-only revision read surface. Authoring owns candidates and publication;
 * chat only needs the selected immutable release, scoped by workspace and agent.
 */
export interface AgentRevisionRuntimeReaderPort {
  findCurrentPublished(input: { workspaceId: string; agentId: string }): Promise<AgentRevision | null>;
  findRevision(input: { workspaceId: string; agentId: string; revisionId: string }): Promise<AgentRevision | null>;
}

interface ResolvedAgentRevision {
  revisionId: string;
  revision: AgentRevision;
  contextVariableEnablements: AgentRevisionSnapshot["contextVariableEnablements"];
  /** Live agent auth/capability state with revision-scoped behavior projected over it. */
  agent: AgentRecord;
}

export const applyAgentRevisionSnapshot = (agent: AgentRecord, revision: AgentRevision): AgentRecord => ({
  ...agent,
  customInstruction: revision.snapshot.customInstruction ?? "",
  authoredDirectives: revision.snapshot.directives,
  // `agentSkills` is absent on snapshots predating skill tracking (see
  // agentRevision.ts); leave `authoredAgentSkills` undefined in that case so
  // turn-dispatch composition (agentSkillTurnSkillProvider) knows to fall back
  // to a live lookup instead of treating an absent field as "no skills". The
  // snapshot's `kind`/`invocationMode` are validated-shape-but-open strings (see
  // agentRevision.ts for why); every element was already validated against the
  // narrower AgentSkillSpine shape by AgentSkillsService before it was ever
  // written to agent_skills, so this cast is safe the same way this repository
  // family already casts a raw DB column to AgentSkillKind elsewhere.
  ...(revision.snapshot.agentSkills !== undefined
    ? { authoredAgentSkills: revision.snapshot.agentSkills as unknown as AgentSkillSpine[] }
    : {}),
});

/**
 * Resolves the release a chat turn is allowed to use. It deliberately never reads
 * drafts or mutable scoped resource rows: a missing release is a product error,
 * not permission to substitute the current authoring state.
 */
export class AgentRevisionRuntimeResolver {
  constructor(private readonly reader: AgentRevisionRuntimeReaderPort) {}

  async resolveNew(input: { workspaceId: string; agent: AgentRecord }): Promise<ResolvedAgentRevision> {
    const revision = await this.reader.findCurrentPublished({
      workspaceId: input.workspaceId,
      agentId: input.agent.id,
    });
    if (!revision) {
      throw notFound("Agent is not published");
    }
    return {
      revisionId: revision.id,
      revision,
      contextVariableEnablements: revision.snapshot.contextVariableEnablements,
      agent: applyAgentRevisionSnapshot(input.agent, revision),
    };
  }

  async resolvePinned(input: {
    workspaceId: string;
    agent: AgentRecord;
    revisionId: string;
    /** Candidate revisions are reachable only through the trusted operator-test runner. */
    allowCandidate?: boolean;
  }): Promise<ResolvedAgentRevision> {
    const revision = await this.reader.findRevision({
      workspaceId: input.workspaceId,
      agentId: input.agent.id,
      revisionId: input.revisionId,
    });
    if (!revision) {
      throw notFound("Agent revision is unavailable");
    }
    if (!revision.publishedAt && !input.allowCandidate) {
      throw notFound("Agent revision is not published");
    }
    return {
      revisionId: revision.id,
      revision,
      contextVariableEnablements: revision.snapshot.contextVariableEnablements,
      agent: applyAgentRevisionSnapshot(input.agent, revision),
    };
  }
}
