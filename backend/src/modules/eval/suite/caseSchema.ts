import { z } from "zod";

import type { InternalAgentConfig } from "../../agents/public.js";
import type {
  AssistantClientContextCapabilities,
  AssistantPageContext,
} from "../../chat/contracts/index.js";
import { renderRoutineInvocation } from "../../routines/public.js";
import type { TurnExecutionMode } from "../../../shared/domain/turnExecutionMode.js";
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
/**
 * A case carrying this tag holds its `llm_judge` assertions to zero rate-drop tolerance: the share
 * of samples in which no judge verdict failed may not fall below the case's recorded pass rate.
 * It is for judges whose single failure is the defect itself (a quick reply that states a fact),
 * where the suite's general tolerance would let a reply recorded at five in five make a claim in
 * two samples of five and still pass.
 */
export const ZERO_TOLERANCE_JUDGE_TAG = "judge-zero-tolerance";

export interface ConversationQualityCase {
  id: string;
  name: string;
  description?: string;
  /** Free-form labels for filtering a run, e.g. "routing" | "routine" | "grounding". */
  tags?: string[];
  /**
   * `"review"` drives the case as a review turn: `query` is recorded as the customer's
   * message, after `history`, and answered as a draft, so no reply is persisted, no routine
   * runs and no skill effect fires. A review case takes no other turn input. Absent, the
   * case is a live turn.
   */
  executionMode?: Extract<TurnExecutionMode, "review">;
  /** Prior turns, oldest first, replayed as conversation history before `query`. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** The message to drive; absent when the turn is a `routineInvocation`. */
  query?: string;
  /**
   * Drive the turn as a calling agent's tool call to an exposed routine instead of a
   * message: the named routine is admitted directly with these slot values prefilled.
   * Exactly one of `query` and `routineInvocation` is set.
   */
  routineInvocation?: { toolName: string; input: Record<string, string | number | boolean> };
  /** Ephemeral host-page input supplied to this turn only. */
  pageContext?: AssistantPageContext;
  /** Client-advertised context capabilities supplied alongside `pageContext`. */
  clientContextCapabilities?: AssistantClientContextCapabilities;
  /** Seed a mid-routine position so the agent resumes instead of activating fresh. */
  routineStartState?: EvalRunRoutineStartState;
  agentConfigOverride?: Partial<InternalAgentConfig>;
  /**
   * Drives `query` as a voice turn instead of a chat message: run through the real voice turn
   * policy (bridge timing, the turn limit, the outcome derivation — see
   * `modules/voiceChannel/services/voiceTurnPolicy.ts`) rather than a plain chat reply. See
   * {@link VoiceEvalTurnScript} for why this needs its own field.
   */
  voiceTurn?: VoiceEvalTurnScript;
  assertions: SuiteAssertion[];
}

/**
 * One chat-stream event the voice turn policy reads to decide bridging and the turn limit: a
 * phase marker (the chat turn starting to search or compose), a piece of the answer's text, the
 * turn's close (optionally with a hand-off, for an outcome case), or `stall`, which never
 * advances and never closes, so a case built on it exercises the turn limit alone. The
 * deterministic voice runner (`tests/fixtures/voice-eval/`) plays this script as the turn's chat
 * backend; a live run answers for real and ignores it.
 */
export type VoiceEvalChatScriptEvent =
  | { type: "status"; stage: "interpreting" | "searching" | "composing" }
  | { type: "chunk"; text: string }
  | {
      type: "done";
      handoff?: { reason: "routine_handoff" | "routine_stuck" | "retrieval_miss"; collectedSlotCount: number };
    }
  | { type: "stall" };

/**
 * A voice case's scripted chat backend. The plain case shape (`query` plus answer-content or
 * trace assertions) has no way to express a phase timeline or a turn that never answers — which
 * is exactly the behaviour under test here (bridge timing, the turn limit) — so this is the
 * smallest addition that can say it, rather than a second case format or a parallel voice suite.
 */
export interface VoiceEvalTurnScript {
  chatEvents: VoiceEvalChatScriptEvent[];
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
const suiteAssertionSchema = z.discriminatedUnion("type", [
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
  z.object({ type: z.literal("turn_skips_skill"), skillName: z.string().min(1) }),
  z.object({ type: z.literal("turn_activates_routine"), routineId: z.string().min(1) }),
  z.object({ type: z.literal("routine_step_reached"), routineId: z.string().min(1), stepId: z.string().min(1) }),
  z.object({ type: z.literal("routine_slots_filled"), routineId: z.string().min(1), slotKeys: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("routine_yielded"), routineId: z.string().min(1), stepId: z.string().min(1) }),
  z.object({ type: z.literal("turn_asks_clarification") }),
  z.object({ type: z.literal("turn_grounding_verdict"), verdict: z.enum(["grounded", "degraded", "no_support"]) }),
  z.object({ type: z.literal("turn_answer_coverage"), coverage: z.enum(["answered", "partial", "unanswered", "unclear"]) }),
  z.object({ type: z.literal("turn_persists_no_reply") }),
  z.object({ type: z.literal("turn_reply_source"), source: z.enum(["turn_planning", "composer"]) }),
  z.object({ type: z.literal("turn_directive_committed"), directive: z.string().min(1) }),
  z.object({ type: z.literal("voice_bridge_emitted"), expected: z.boolean() }),
  z.object({ type: z.literal("voice_turn_limit_reached"), expected: z.boolean() }),
  z.object({ type: z.literal("voice_turn_outcome"), kind: z.enum(["continue", "callback_requested"]) }),
]);

const voiceEvalChatScriptEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), stage: z.enum(["interpreting", "searching", "composing"]) }),
  z.object({ type: z.literal("chunk"), text: z.string().min(1) }),
  z.object({
    type: z.literal("done"),
    handoff: z.object({
      reason: z.enum(["routine_handoff", "routine_stuck", "retrieval_miss"]),
      collectedSlotCount: z.number().int().nonnegative(),
    }).optional(),
  }),
  z.object({ type: z.literal("stall") }),
]);

const voiceEvalTurnScriptSchema = z.object({
  chatEvents: z.array(voiceEvalChatScriptEventSchema).min(1),
});

/** Turn inputs a review turn has no way to take: it answers a recorded message with its history. */
const REVIEW_UNSUPPORTED_INPUTS = [
  "routineInvocation",
  "routineStartState",
  "pageContext",
  "clientContextCapabilities",
  "agentConfigOverride",
] as const;

/**
 * Turn inputs a voice case has no way to take: it is always a fresh, non-review turn driven by
 * `query` alone, run through the voice turn policy rather than a routine invocation, replayed
 * history, host-page context, or a config override.
 */
const VOICE_UNSUPPORTED_INPUTS = [
  "history",
  "routineInvocation",
  "routineStartState",
  "pageContext",
  "clientContextCapabilities",
  "agentConfigOverride",
] as const;

const conversationQualityCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  executionMode: z.literal("review").optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .optional(),
  query: z.string().min(1).optional(),
  routineInvocation: z.object({
    toolName: z.string().min(1),
    input: z.record(z.union([z.string(), z.number(), z.boolean()])),
  }).optional(),
  pageContext: pageContextSchema.optional(),
  clientContextCapabilities: clientContextCapabilitiesSchema.optional(),
  routineStartState: z.record(z.unknown()).optional(),
  agentConfigOverride: z.record(z.unknown()).optional(),
  voiceTurn: voiceEvalTurnScriptSchema.optional(),
  assertions: z.array(suiteAssertionSchema),
}).refine(
  (value) => (value.query === undefined) !== (value.routineInvocation === undefined),
  { message: "exactly one of query or routineInvocation is required", path: ["query"] },
).refine(
  (value) => value.executionMode !== "review" || REVIEW_UNSUPPORTED_INPUTS.every((input) => value[input] === undefined),
  { message: `a review case takes only query and history, not ${REVIEW_UNSUPPORTED_INPUTS.join(", ")}`, path: ["executionMode"] },
).refine(
  (value) => value.voiceTurn === undefined || value.executionMode !== "review",
  { message: "a voice case cannot also run in review mode", path: ["voiceTurn"] },
).refine(
  (value) => value.voiceTurn === undefined || VOICE_UNSUPPORTED_INPUTS.every((input) => value[input] === undefined),
  { message: `a voice case takes only query and voiceTurn, not ${VOICE_UNSUPPORTED_INPUTS.join(", ")}`, path: ["voiceTurn"] },
);

/**
 * The text the case's turn runs on: the query, or a tool call rendered exactly as the
 * chat module records it, so a judge and a replayed history read the same line.
 */
export const conversationQualityCaseTurnText = (
  evalCase: Pick<ConversationQualityCase, "query" | "routineInvocation">,
): string => evalCase.query ?? (evalCase.routineInvocation ? renderRoutineInvocation(evalCase.routineInvocation) : "");

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
