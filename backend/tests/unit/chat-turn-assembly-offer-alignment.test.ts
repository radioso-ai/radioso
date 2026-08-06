import { describe, expect, it } from "vitest";

import type { ClarificationCandidate, PendingClarification } from "@radioso/conversation-contract";

import { alignOfferPendingCandidates } from "../../src/modules/chat/services/chatTurnAssembly.js";

// Characterizes the "offer" clarification storage alignment: the pending row
// `maybeClarifyRetrievalSense` persists for an "offer" decision must be exactly what
// the visitor was offered, in the order offered — the order every later reader (the
// LLM reply mapper's numbered options block, any positional reference) treats as
// authoritative. The "ask" path establishes the same single source of truth by
// storing `phrased.presented`.
//
// The offer effect carries `[topPick, ...alternatives]`, but only the alternatives
// are rendered to the visitor (`retrieval-sense-offer.md` interpolates
// `{{alternatives}}`); the top pick is the interpretation already answered.

const candidate = (
  overrides: Partial<ClarificationCandidate> & Pick<ClarificationCandidate, "id" | "label">,
): ClarificationCandidate => ({
  confidence: 0.8,
  payload: {},
  ...overrides,
});

const pendingOffer = (candidates: ClarificationCandidate[]): Omit<PendingClarification, "askedEventId"> => ({
  sessionId: "conv_1",
  source: "retrieval_sense",
  originalQuery: "what is ananda yoga",
  mode: "offer",
  candidates,
  status: "pending",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
});

describe("alignOfferPendingCandidates", () => {
  it("stores only the offered alternatives, so position 1 is the first option the visitor actually saw", () => {
    const top = candidate({ id: "top", label: "Ananda Yoga overview" });
    const alternative = candidate({ id: "alt", label: "Newer Ananda Yoga page" });

    const aligned = alignOfferPendingCandidates(pendingOffer([top, alternative]), [alternative]);

    // Storing the already-answered top pick at position 0 made "the first one"
    // resolve to the document the visitor was never offered.
    expect(aligned.candidates).toEqual([alternative]);
    expect(aligned.candidates.map((c) => c.id)).not.toContain("top");
  });

  it("preserves the offered order across several alternatives", () => {
    const top = candidate({ id: "top", label: "Ananda Yoga overview" });
    const first = candidate({ id: "alt-1", label: "Raja yoga" });
    const second = candidate({ id: "alt-2", label: "Kriya yoga" });

    const aligned = alignOfferPendingCandidates(pendingOffer([top, first, second]), [first, second]);

    expect(aligned.candidates.map((c) => c.id)).toEqual(["alt-1", "alt-2"]);
  });

  it("removes a non-presentable alternative rather than storing it at a position nothing displayed", () => {
    const top = candidate({ id: "top", label: "Ananda Yoga overview" });
    const emptyLabel = candidate({ id: "doc-empty", label: "   " });
    const idAsLabel = candidate({ id: "doc-42", label: "doc-42" });
    const alternative = candidate({ id: "alt", label: "Newer Ananda Yoga page" });

    const aligned = alignOfferPendingCandidates(
      pendingOffer([top, emptyLabel, idAsLabel, alternative]),
      [emptyLabel, idAsLabel, alternative],
    );

    expect(aligned.candidates).toEqual([alternative]);
  });

  it("leaves every other pending field untouched", () => {
    const top = candidate({ id: "top", label: "Ananda Yoga overview" });
    const alternative = candidate({ id: "alt", label: "Newer Ananda Yoga page" });

    const aligned = alignOfferPendingCandidates(pendingOffer([top, alternative]), [alternative]);

    expect(aligned).toMatchObject({
      sessionId: "conv_1",
      source: "retrieval_sense",
      originalQuery: "what is ananda yoga",
      mode: "offer",
      status: "pending",
    });
  });
});
