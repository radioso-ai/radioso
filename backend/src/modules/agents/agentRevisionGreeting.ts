import type { AgentGreetingSnapshot, AgentRevisionSnapshot } from "./agentRevision.js";

/** Absent `greeting` (a draft/revision frozen before this field existed) reads back
 * identically to an authored-but-inactive one: Automatic mode, no content. */
export const readAgentRevisionGreeting = (snapshot: Pick<AgentRevisionSnapshot, "greeting">): AgentGreetingSnapshot =>
  snapshot.greeting ?? { exactWordsEnabled: false, exactContent: null };

/**
 * The greeting as a fixed shape for a `JSON.stringify` comparison: a greeting absent from one
 * snapshot reads as the default (via `readAgentRevisionGreeting`), and a variant's chip labels,
 * a record whose key order depends on which writer or JSONB round trip produced it, are listed
 * by sorted key. Chip order and variant order are authored, so they stay as they are.
 */
export const comparableGreeting = (snapshot: Pick<AgentRevisionSnapshot, "greeting">) => {
  const greeting = readAgentRevisionGreeting(snapshot);
  return {
    exactWordsEnabled: greeting.exactWordsEnabled,
    exactContent: greeting.exactContent && {
      chips: greeting.exactContent.chips,
      variants: greeting.exactContent.variants.map((variant) => ({
        locale: variant.locale,
        body: variant.body,
        chipLabels: Object.entries(variant.chipLabels).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      })),
    },
  };
};
