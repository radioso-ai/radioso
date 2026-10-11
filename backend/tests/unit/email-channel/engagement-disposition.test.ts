import { describe, expect, it } from "vitest";

import {
  resolveEngagementDisposition,
  type EngagementDispositionInput,
} from "../../../src/modules/connectors/plugins/email/emailEngagementDisposition.js";
import type { InboundClassification } from "../../../src/modules/connectors/plugins/email/emailInboundClassification.js";
import type { EngagementMode } from "../../../src/modules/emailChannel/public.js";

type Mailbox = NonNullable<EngagementDispositionInput["mailbox"]>;
type Thread = EngagementDispositionInput["thread"];

const MODES: readonly EngagementMode[] = ["operator_only", "draft", "auto"];
const CLASSIFICATIONS: readonly InboundClassification[] = ["person", "automated_sender", "bounce", "self_sender", "spam"];
const THREADS: readonly Thread[] = [
  { kind: "new" },
  { kind: "existing", ownership: "ai_owned" },
  { kind: "existing", ownership: "human_owned" },
  { kind: "participant_mismatch" },
];
const NEW: Thread = { kind: "new" };
const AI_OWNED: Thread = { kind: "existing", ownership: "ai_owned" };
const HUMAN_OWNED: Thread = { kind: "existing", ownership: "human_owned" };
const MISMATCH: Thread = { kind: "participant_mismatch" };

const draftMailbox: Mailbox = { effectiveMode: "draft", enabled: true, hasAgent: true };

const input = (overrides: Partial<EngagementDispositionInput> = {}): EngagementDispositionInput => ({
  mailbox: draftMailbox,
  classification: "person",
  thread: NEW,
  generationBudgetExhausted: false,
  ...overrides,
});

const mailbox = (overrides: Partial<Mailbox>): Mailbox => ({ ...draftMailbox, ...overrides });

const everyInput = function* (): Generator<EngagementDispositionInput> {
  for (const effectiveMode of MODES) {
    for (const enabled of [true, false]) {
      for (const hasAgent of [true, false]) {
        for (const classification of CLASSIFICATIONS) {
          for (const thread of THREADS) {
            for (const generationBudgetExhausted of [true, false]) {
              yield {
                mailbox: { effectiveMode, enabled, hasAgent },
                classification,
                thread,
                generationBudgetExhausted,
              };
            }
          }
        }
      }
    }
  }
};

describe("resolveEngagementDisposition", () => {
  describe("drops", () => {
    it("drops mail that resolved no mailbox, with nothing to note on", () => {
      expect(resolveEngagementDisposition(input({ mailbox: null })))
        .toEqual({ kind: "drop", reason: "no_mailbox", noteOnThread: false });
    });

    it("drops mail for a disabled mailbox before reading the classification", () => {
      expect(resolveEngagementDisposition(input({ mailbox: mailbox({ enabled: false }), classification: "bounce" })))
        .toEqual({ kind: "drop", reason: "mailbox_disabled", noteOnThread: false });
    });

    it.each(["automated_sender", "self_sender", "bounce", "spam"] as const)("drops %s mail whatever the mode", (classification) => {
      for (const effectiveMode of MODES) {
        expect(resolveEngagementDisposition(input({ mailbox: mailbox({ effectiveMode }), classification })))
          .toEqual({ kind: "drop", reason: classification, noteOnThread: false });
      }
    });

    it("drops spam on every thread, a human-owned one included, and notes it there", () => {
      for (const thread of [AI_OWNED, HUMAN_OWNED]) {
        expect(resolveEngagementDisposition(input({ classification: "spam", thread })))
          .toEqual({ kind: "drop", reason: "spam", noteOnThread: true });
      }
    });

    it("drops a participant mismatch and notes it on the thread", () => {
      expect(resolveEngagementDisposition(input({ thread: MISMATCH })))
        .toEqual({ kind: "drop", reason: "participant_mismatch", noteOnThread: true });
    });

    it("drops on the classification before the participant mismatch", () => {
      expect(resolveEngagementDisposition(input({ classification: "automated_sender", thread: MISMATCH })))
        .toEqual({ kind: "drop", reason: "automated_sender", noteOnThread: true });
    });

    it("notes a drop on the thread exactly when a thread exists", () => {
      for (const candidate of everyInput()) {
        const disposition = resolveEngagementDisposition(candidate);
        if (disposition.kind !== "drop") continue;
        expect(disposition.noteOnThread, JSON.stringify(candidate)).toBe(candidate.thread.kind !== "new");
      }
      expect(resolveEngagementDisposition(input({ mailbox: null, thread: AI_OWNED })))
        .toEqual({ kind: "drop", reason: "no_mailbox", noteOnThread: false });
    });
  });

  describe("ingest only", () => {
    it("ingests into a human-owned conversation without changing ownership, whatever the mode", () => {
      for (const effectiveMode of MODES) {
        expect(resolveEngagementDisposition(input({ mailbox: mailbox({ effectiveMode }), thread: HUMAN_OWNED, generationBudgetExhausted: true })))
          .toEqual({ kind: "ingest_only", reason: "human_owned", humanOwnershipReason: null });
      }
    });

    it("ingests an operator-only mailbox's mail as human-owned", () => {
      for (const thread of [NEW, AI_OWNED]) {
        expect(resolveEngagementDisposition(input({ mailbox: mailbox({ effectiveMode: "operator_only" }), thread, generationBudgetExhausted: true })))
          .toEqual({ kind: "ingest_only", reason: "operator_only_mailbox", humanOwnershipReason: "operator_only_mailbox" });
      }
    });

    it("ingests as operator-only when the mailbox has no agent", () => {
      for (const effectiveMode of ["draft", "auto"] as const) {
        expect(resolveEngagementDisposition(input({ mailbox: mailbox({ effectiveMode, hasAgent: false }), generationBudgetExhausted: true })))
          .toEqual({ kind: "ingest_only", reason: "no_agent", humanOwnershipReason: "operator_only_mailbox" });
      }
    });

    it("ingests as human-owned when the generation budget is exhausted", () => {
      for (const effectiveMode of ["draft", "auto"] as const) {
        for (const thread of [NEW, AI_OWNED]) {
          expect(resolveEngagementDisposition(input({ mailbox: mailbox({ effectiveMode }), thread, generationBudgetExhausted: true })))
            .toEqual({ kind: "ingest_only", reason: "generation_budget", humanOwnershipReason: "generation_budget" });
        }
      }
    });

    it("never asks for human ownership of a conversation that is already human-owned", () => {
      for (const candidate of everyInput()) {
        const disposition = resolveEngagementDisposition(candidate);
        if (disposition.kind !== "ingest_only" || candidate.thread.kind !== "existing" || candidate.thread.ownership !== "human_owned") continue;
        expect(disposition.humanOwnershipReason, JSON.stringify(candidate)).toBeNull();
      }
    });
  });

  describe("run_review_turn", () => {
    it.each(["draft", "auto"] as const)("runs a review turn for a person on a %s mailbox", (effectiveMode) => {
      for (const thread of [NEW, AI_OWNED]) {
        expect(resolveEngagementDisposition(input({ mailbox: mailbox({ effectiveMode }), thread })))
          .toEqual({ kind: "run_review_turn" });
      }
    });

    it("needs draft or auto, an enabled mailbox with an agent, a person, an AI-owned thread and budget left", () => {
      for (const candidate of everyInput()) {
        const { mailbox: box, classification, thread, generationBudgetExhausted } = candidate;
        const expected = box !== null
          && box.enabled
          && box.hasAgent
          && box.effectiveMode !== "operator_only"
          && classification === "person"
          && (thread.kind === "new" || (thread.kind === "existing" && thread.ownership === "ai_owned"))
          && !generationBudgetExhausted;
        expect(resolveEngagementDisposition(candidate).kind === "run_review_turn", JSON.stringify(candidate)).toBe(expected);
      }
    });
  });

  describe("rule order", () => {
    it("applies mailbox, classification, participant, ownership, mode, agent, then budget", () => {
      const reasons = [
        input({ mailbox: null, classification: "bounce", thread: MISMATCH, generationBudgetExhausted: true }),
        input({ mailbox: mailbox({ enabled: false, effectiveMode: "operator_only", hasAgent: false }), classification: "bounce", thread: MISMATCH }),
        input({ mailbox: mailbox({ effectiveMode: "operator_only" }), classification: "self_sender", thread: MISMATCH }),
        input({ classification: "spam", thread: MISMATCH }),
        input({ classification: "person", thread: MISMATCH, generationBudgetExhausted: true }),
        input({ mailbox: mailbox({ effectiveMode: "operator_only", hasAgent: false }), thread: HUMAN_OWNED, generationBudgetExhausted: true }),
        input({ mailbox: mailbox({ effectiveMode: "operator_only", hasAgent: false }), thread: AI_OWNED, generationBudgetExhausted: true }),
        input({ mailbox: mailbox({ effectiveMode: "auto", hasAgent: false }), thread: AI_OWNED, generationBudgetExhausted: true }),
        input({ mailbox: mailbox({ effectiveMode: "auto" }), thread: AI_OWNED, generationBudgetExhausted: true }),
      ].map((candidate) => {
        const disposition = resolveEngagementDisposition(candidate);
        return disposition.kind === "run_review_turn" ? disposition.kind : disposition.reason;
      });

      expect(reasons).toEqual([
        "no_mailbox",
        "mailbox_disabled",
        "self_sender",
        "spam",
        "participant_mismatch",
        "human_owned",
        "operator_only_mailbox",
        "no_agent",
        "generation_budget",
      ]);
    });
  });
});
