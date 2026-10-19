import { describe, expect, it, vi } from "vitest";

import type { ClarificationPolicy } from "@radioso/conversation-contract";

import { evaluateRetrievalSenseClarification } from "../../src/modules/retrieval/services/retrievalSenseClarification.js";
import type { RetrievalSenseClarificationCandidate } from "../../src/modules/retrieval/services/senseGroupingService.js";

// The production retrieval-sense policy (app/server/builders/chat.ts).
const PRODUCTION_POLICY: ClarificationPolicy = { floor: 0, margin: 0.15, askMargin: 0.01, maxOptions: 4 };

const sense = (id: string, confidence: number): RetrievalSenseClarificationCandidate => ({
  id,
  label: `Reading ${id}`,
  confidence,
  labelStatus: "generated",
  payload: { documentIds: [id] },
});

// The confidences a live turn recorded while a booking routine was active: the isolated,
// least relevant document leads two near-identical course pages by less than the margin.
const tooCloseToCall = [sense("doc_online_yoga", 0.81746), sense("doc_breath_course", 0.761521), sense("doc_arts_weekend", 0.753457)];

const evaluate = (input: {
  candidates: RetrievalSenseClarificationCandidate[];
  suppressAskReason?: "page_capture";
}) =>
  evaluateRetrievalSenseClarification({
    detector: { detect: vi.fn(async () => input.candidates) },
    workspaceId: "ws_1",
    rankedCandidates: [],
    conversationId: "conv_1",
    messageId: "msg_1",
    originalQuery: "Mi mandi un preventivo completo per l'evento?",
    policy: PRODUCTION_POLICY,
    suppressAsk: true,
    ...(input.suppressAskReason ? { suppressAskReason: input.suppressAskReason } : {}),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

describe("retrieval sense with the visitor's question suppressed", () => {
  it("keeps every sense when the senses are too close to call and retrieval is the turn's only evidence", async () => {
    const effect = await evaluate({ candidates: tooCloseToCall });

    expect(effect?.kind).toBe("proceed");
    expect(effect && "documentScope" in effect ? effect.documentScope : undefined).toBeUndefined();
    expect(effect?.stage?.outputs).toMatchObject({ surface: "retrieval_sense", decision: "suppressed", reason: "all_senses_kept" });
    expect(effect?.stage?.outputs).not.toHaveProperty("chosenCandidateId");
    expect((effect?.stage?.outputs as { candidates?: unknown[] }).candidates).toHaveLength(3);
  });

  it("still scopes retrieval to a sense that clears the margin", async () => {
    const effect = await evaluate({ candidates: [sense("doc_breath_course", 0.9), sense("doc_arts_weekend", 0.6)] });

    expect(effect?.kind).toBe("proceed");
    expect(effect && "documentScope" in effect ? effect.documentScope : undefined).toEqual(["doc_breath_course"]);
  });

  it("keeps the leading sense's scope on a page capture, where the page evidence answers the turn", async () => {
    const effect = await evaluate({ candidates: tooCloseToCall, suppressAskReason: "page_capture" });

    expect(effect && "documentScope" in effect ? effect.documentScope : undefined).toEqual(["doc_online_yoga"]);
    expect(effect?.stage?.outputs).toMatchObject({ decision: "suppressed", reason: "page_capture", chosenCandidateId: "doc_online_yoga" });
  });
});
