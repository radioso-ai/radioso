import { canonicalJson } from "../../shared/domain/canonicalContentHash.js";
import type { AgentGreetingSnapshot, AgentRevisionSnapshot } from "./agentRevision.js";

/** Absent `greeting` (a draft/revision frozen before this field existed) reads back
 * identically to an authored-but-inactive one: Automatic mode, no content. */
export const readAgentRevisionGreeting = (snapshot: Pick<AgentRevisionSnapshot, "greeting">): AgentGreetingSnapshot =>
  snapshot.greeting ?? { exactWordsEnabled: false, exactContent: null };

/**
 * The greeting as one canonical string, so two snapshots can be compared for a greeting change.
 * A greeting absent from one snapshot reads as the default (via `readAgentRevisionGreeting`), and
 * `canonicalJson` fixes the key order of every object, which depends on which writer or JSONB
 * round trip produced it. It reads the greeting whole, so a field it gains later is compared
 * without anyone listing it here. Arrays keep their authored order: chips and variants are ordered.
 */
export const canonicalGreeting = (snapshot: Pick<AgentRevisionSnapshot, "greeting">): string =>
  canonicalJson(JSON.parse(JSON.stringify(readAgentRevisionGreeting(snapshot))) as unknown);
