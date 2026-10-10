import type { EngagementMode } from "../../../emailChannel/public.js";

import type { InboundClassification } from "./emailInboundClassification.js";

export interface EngagementDispositionInput {
  /** Null when the delivery resolved no mailbox. `effectiveMode` and `enabled` come from `effectiveEngagementMode`. */
  mailbox: { effectiveMode: EngagementMode; enabled: boolean; hasAgent: boolean } | null;
  classification: InboundClassification;
  thread: { kind: "new" } | { kind: "existing"; ownership: "ai_owned" | "human_owned" } | { kind: "participant_mismatch" };
  generationBudgetExhausted: boolean;
}

export type DropReason = "no_mailbox" | "mailbox_disabled" | "automated_sender" | "self_sender" | "bounce" | "spam" | "participant_mismatch";
export type IngestOnlyReason = "operator_only_mailbox" | "human_owned" | "generation_budget" | "no_agent";
type HumanOwnershipReason = "operator_only_mailbox" | "generation_budget";

export type EngagementDisposition =
  | { kind: "drop"; reason: DropReason; noteOnThread: boolean }
  | { kind: "ingest_only"; reason: IngestOnlyReason; humanOwnershipReason: HumanOwnershipReason | null }
  | { kind: "run_review_turn" };

// A drop is an event-log row; where the delivery reached a thread it is also noted there.
const drop = (reason: DropReason, input: EngagementDispositionInput): EngagementDisposition =>
  ({ kind: "drop", reason, noteOnThread: input.mailbox !== null && input.thread.kind !== "new" });

const ingestOnly = (
  reason: IngestOnlyReason,
  humanOwnershipReason: HumanOwnershipReason | null,
): EngagementDisposition => ({ kind: "ingest_only", reason, humanOwnershipReason });

/**
 * Whether the agent runs on an accepted inbound message (FR-017), decided structurally before any
 * model call. Rules apply in this order, and the first that fires wins:
 *
 * 1. no mailbox, then a disabled mailbox: drop;
 * 2. automated, self-sent, bounced, or spam mail: drop;
 * 3. a sender who is not the thread's participant: drop (FR-011);
 * 4. a human-owned conversation: ingest, whatever the mode (FR-021);
 * 5. an `operator_only` mailbox, or one with no agent, which behaves as `operator_only` (FR-018);
 * 6. an exhausted generation budget: ingest as human-owned (FR-023);
 * 7. otherwise run a review turn.
 *
 * Ingest-only outcomes ask for human ownership unless the conversation already is human-owned.
 */
export const resolveEngagementDisposition = (input: EngagementDispositionInput): EngagementDisposition => {
  const { mailbox, classification, thread } = input;
  if (mailbox === null) return drop("no_mailbox", input);
  if (!mailbox.enabled) return drop("mailbox_disabled", input);
  if (classification !== "person") return drop(classification, input);
  if (thread.kind === "participant_mismatch") return drop("participant_mismatch", input);

  const alreadyHumanOwned = thread.kind === "existing" && thread.ownership === "human_owned";
  if (alreadyHumanOwned) return ingestOnly("human_owned", null);
  if (mailbox.effectiveMode === "operator_only") return ingestOnly("operator_only_mailbox", "operator_only_mailbox");
  if (!mailbox.hasAgent) return ingestOnly("no_agent", "operator_only_mailbox");
  if (input.generationBudgetExhausted) return ingestOnly("generation_budget", "generation_budget");
  return { kind: "run_review_turn" };
};
