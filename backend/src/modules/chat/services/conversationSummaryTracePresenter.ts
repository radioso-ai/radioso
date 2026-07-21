import type { ActivityTrace } from "../../retrieval/public.js";

/**
 * The prompts the rolling conversation summary (#866) is injected into. Surfaced
 * on the trace stage so an operator can see not just that a summary was applied
 * but which composed prompts saw it.
 */
const SUMMARY_INJECTION_SITES = [
  "turn_interpretation",
  "grounded_answer",
  "direct_answer",
] as const;

/**
 * Appends a conversation-summary stage to a turn's activity trace, mirroring how
 * directive steering is traced. Makes the otherwise-invisible rolling summary
 * (#866) visible on the operator debug surface: whether one was available, what it
 * said, and which prompts consume it. Content on the ActivityTrace is intentional —
 * it is the debug surface (it already carries retrieved chunks and directive
 * names), distinct from logs/telemetry, which stay summary-free.
 *
 * The stage is appended on EVERY turn: `applied` with the text when a summary was
 * available to the turn, `skipped` when none exists yet (short conversation or
 * not yet regenerated). An absent summary must still be visible — operators
 * cannot otherwise distinguish "no summary yet" from a broken feature.
 */
export function appendConversationSummaryStage(
  trace: ActivityTrace,
  summary: string | null | undefined,
): ActivityTrace;
export function appendConversationSummaryStage(
  trace: ActivityTrace | undefined,
  summary: string | null | undefined,
): ActivityTrace | undefined;
export function appendConversationSummaryStage(
  trace: ActivityTrace | undefined,
  summary: string | null | undefined,
): ActivityTrace | undefined {
  // Some eval/pipeline runs carry no activity trace at all; with no trace there
  // is no debug surface to annotate.
  if (!trace) {
    return undefined;
  }
  const trimmed = summary?.trim() ?? "";
  const stageId = "conversation_summary";
  // Eval fakes and partial pipeline traces may omit the stage/link arrays.
  const stages = trace.stages ?? [];
  const links = trace.links ?? [];
  const previousStageId = stages.at(-1)?.stageId;

  return {
    ...trace,
    stages: [
      ...stages,
      trimmed
        ? {
          stageId,
          kind: "conversation_summary",
          label: "Conversation summary",
          status: "applied",
          startedAt: new Date().toISOString(),
          outputs: {
            summary: trimmed,
            summaryChars: trimmed.length,
            injectedInto: [...SUMMARY_INJECTION_SITES],
          },
        }
        : {
          stageId,
          kind: "conversation_summary",
          label: "Conversation summary",
          status: "skipped",
          reason: "no_summary_yet",
          startedAt: new Date().toISOString(),
          outputs: {
            // Regeneration starts once the conversation outgrows the recent-message
            // window; until then the window carries the whole conversation.
            note: "No rolling summary exists for this conversation yet.",
          },
        },
    ],
    links: previousStageId
      ? [...links, { fromStageId: previousStageId, toStageId: stageId, kind: "sequence" as const }]
      : links,
  };
}
