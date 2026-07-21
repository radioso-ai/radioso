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
 * (#866) visible on the operator debug surface: whether one was injected, what it
 * said, and which prompts saw it. Content on the ActivityTrace is intentional —
 * it is the debug surface (it already carries retrieved chunks and directive
 * names), distinct from logs/telemetry, which stay summary-free.
 *
 * Behavior-preserving when there is no summary: an absent or empty summary leaves
 * the trace untouched, exactly as a short conversation with no pre-window context.
 */
export const appendConversationSummaryStage = (
  trace: ActivityTrace,
  summary: string | null | undefined,
): ActivityTrace => {
  if (!summary || summary.trim().length === 0) {
    return trace;
  }

  const stageId = "conversation_summary";
  const previousStageId = trace.stages.at(-1)?.stageId;

  return {
    ...trace,
    stages: [
      ...trace.stages,
      {
        stageId,
        kind: "conversation_summary",
        label: "Conversation summary",
        status: "applied",
        startedAt: new Date().toISOString(),
        outputs: {
          summary,
          summaryChars: summary.length,
          injectedInto: [...SUMMARY_INJECTION_SITES],
        },
      },
    ],
    links: previousStageId
      ? [...trace.links, { fromStageId: previousStageId, toStageId: stageId, kind: "sequence" as const }]
      : trace.links,
  };
};
