import { z } from "zod";

import type { InternalAgentConfig } from "../../agents/public.js";
import type {
  AssistantClientContextCapabilities,
  AssistantPageContext,
} from "../../chat/contracts/index.js";
import type { EvalRunRoutineStartState } from "../domain/types.js";
import type { SuiteAssertion } from "./scoring.js";

/**
 * A conversation-quality case is a committed, version-controlled unit of expected
 * behaviour. Unlike the DB-backed product eval cases (captured per workspace by
 * operators), these live in the repo, so they diff in a PR and grow by contribution.
 *
 * A case names the turn to drive (`query`, optional multi-turn `history`, optional
 * `routineStartState` to resume mid-routine) and the assertions that must hold. All
 * cases run against the suite's fixed seed agent + corpus, so there is no per-case
 * agent binding; `agentConfigOverride` exists only for cases that deliberately probe a
 * config change.
 */
export interface ConversationQualityCase {
  id: string;
  name: string;
  description?: string;
  /** Free-form labels for filtering a run, e.g. "routing" | "routine" | "grounding". */
  tags?: string[];
  /** Prior turns, oldest first, replayed as conversation history before `query`. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  query: string;
  /** Ephemeral host-page input supplied to this turn only. */
  pageContext?: AssistantPageContext;
  /** Client-advertised context capabilities supplied alongside `pageContext`. */
  clientContextCapabilities?: AssistantClientContextCapabilities;
  /** Seed a mid-routine position so the agent resumes instead of activating fresh. */
  routineStartState?: EvalRunRoutineStartState;
  agentConfigOverride?: Partial<InternalAgentConfig>;
  assertions: SuiteAssertion[];
}

const answerMatchMode = z.enum(["substring", "regex"]);
const metadataValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const pageContextSchema = z.object({
  pageUrl: z.string().trim().max(2048).nullable().optional(),
  pageTitle: z.string().trim().max(180).nullable().optional(),
  pageLocale: z.string().trim().max(35).nullable().optional(),
  browserLocale: z.string().trim().max(35).nullable().optional(),
  content: z.string().trim().max(6000).nullable().optional(),
});
const clientContextCapabilitiesSchema = z.object({
  "page.read": z.object({
    available: z.boolean(),
    mode: z.enum(["metadata", "content"]).nullable(),
    supportedOperations: z
      .array(z.enum(["metadata", "lookup", "summarize"]))
      .max(3),
  }).optional(),
});

/**
 * Runtime guard for the full assertion vocabulary (shipped product assertions + suite
 * trace assertions). The TS `SuiteAssertion` union is authoritative for authoring; this
 * schema validates loaded/contributed data and catches drift in tests.
 */
export const suiteAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("retrieval_includes_document"), documentId: z.string().min(1) }),
  z.object({ type: z.literal("retrieval_excludes_document"), documentId: z.string().min(1) }),
  z.object({ type: z.literal("retrieval_top_k_includes_document"), documentId: z.string().min(1), k: z.number().int().positive() }),
  z.object({ type: z.literal("retrieval_document_order"), documentIds: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("retrieval_chunk_metadata"), documentId: z.string().min(1), metadata: z.record(metadataValue) }),
  z.object({ type: z.literal("answer_cites_document"), documentId: z.string().min(1) }),
  z.object({ type: z.literal("answer_contains"), pattern: z.string().min(1), matchMode: answerMatchMode, caseSensitive: z.boolean().optional() }),
  z.object({ type: z.literal("answer_does_not_contain"), pattern: z.string().min(1), matchMode: answerMatchMode, caseSensitive: z.boolean().optional() }),
  z.object({ type: z.literal("llm_judge"), expectedAnswer: z.string().min(1), criteria: z.string().optional() }),
  z.object({ type: z.literal("turn_route"), route: z.enum(["retrieval", "direct"]) }),
  z.object({ type: z.literal("turn_uses_skill"), skillName: z.string().min(1) }),
  z.object({ type: z.literal("turn_activates_routine"), routineId: z.string().min(1) }),
  z.object({ type: z.literal("routine_step_reached"), routineId: z.string().min(1), stepId: z.string().min(1) }),
  z.object({ type: z.literal("turn_asks_clarification") }),
  z.object({ type: z.literal("turn_grounding_verdict"), verdict: z.enum(["grounded", "degraded", "no_support"]) }),
]);

export const conversationQualityCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .optional(),
  query: z.string().min(1),
  pageContext: pageContextSchema.optional(),
  clientContextCapabilities: clientContextCapabilitiesSchema.optional(),
  routineStartState: z.record(z.unknown()).optional(),
  agentConfigOverride: z.record(z.unknown()).optional(),
  assertions: z.array(suiteAssertionSchema),
});

/**
 * Validates a dataset and returns it typed. Throws (via Zod) on malformed input, and
 * additionally enforces that case ids are unique — a duplicate id would silently
 * collapse two cases into one baseline entry.
 */
export const parseConversationQualityCases = (input: unknown): ConversationQualityCase[] => {
  const parsed = z.array(conversationQualityCaseSchema).parse(input);
  const seen = new Set<string>();
  for (const item of parsed) {
    if (seen.has(item.id)) {
      throw new Error(`Duplicate conversation-quality case id: ${item.id}`);
    }
    seen.add(item.id);
  }
  return parsed as ConversationQualityCase[];
};
