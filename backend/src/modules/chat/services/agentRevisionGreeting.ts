import type { AgentRevisionRuntimeResolver, ConversationAgent } from "../../agents/public.js";
import { DEFAULT_AGENT_LOCALE_FALLBACK, readAgentRevisionGreeting } from "../../agents/public.js";
import { AppError } from "../../../shared/domain/errors.js";
import { resolveExactContent, type ExactContentItem } from "../../../shared/domain/exactContent.js";

export type RevisionGreetingResolverPort = Pick<AgentRevisionRuntimeResolver, "resolveNew" | "resolvePinned">;

interface RevisionGreeting {
  revisionId: string;
  greeting: ReturnType<typeof readAgentRevisionGreeting>;
}

/**
 * The same revision selection a normal turn uses (spec 1150 F13): the published
 * revision for a production start, or the pinned candidate for a trusted
 * test-execution bootstrap (the sole caller that supplies both a trusted agent and a
 * revision id). Returns `null` when no resolver is wired, or when the agent has never
 * published a revision — both leave Automatic as the only option; this never becomes
 * a second way of picking a revision.
 */
export const resolveRevisionGreeting = async (
  resolver: RevisionGreetingResolverPort | undefined,
  input: {
    workspaceId: string;
    agent: ConversationAgent;
    trustedRevision: boolean;
    revisionId?: string;
  },
): Promise<RevisionGreeting | null> => {
  if (!resolver) {
    return null;
  }
  try {
    const resolved = input.trustedRevision && input.revisionId
      ? await resolver.resolvePinned({
          workspaceId: input.workspaceId,
          agent: input.agent,
          revisionId: input.revisionId,
          allowCandidate: true,
        })
      : await resolver.resolveNew({
          workspaceId: input.workspaceId,
          agent: input.agent,
        });
    return { revisionId: resolved.revision.id, greeting: readAgentRevisionGreeting(resolved.revision.snapshot) };
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) {
      return null;
    }
    throw error;
  }
};

/** Exact-mode greeting content, or `null` when the revision greets automatically. */
export const exactGreetingContent = (greeting: RevisionGreeting | null): ExactContentItem | null =>
  greeting?.greeting.exactWordsEnabled && greeting.greeting.exactContent ? greeting.greeting.exactContent : null;

/**
 * Resolves the authored greeting variant for a locale. A greeting has no slot or
 * context values at conversation start, so references resolve against nothing; a
 * variant that needs one is unavailable (FR-011).
 */
export const resolveExactGreeting = (
  exactContent: ExactContentItem,
  input: { agent: Pick<ConversationAgent, "assistantDefaultLocale">; requestedLocale: string | null },
): ReturnType<typeof resolveExactContent> =>
  resolveExactContent(exactContent, {
    requestedLocale: input.requestedLocale,
    agentDefaultLocale: input.agent.assistantDefaultLocale ?? DEFAULT_AGENT_LOCALE_FALLBACK,
    references: new Map(),
  });
