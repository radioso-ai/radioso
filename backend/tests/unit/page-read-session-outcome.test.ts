import { describe, expect, it } from "vitest";

import {
  mergePageReadDecision,
  evaluatePageReadGate,
  type PageReadCandidate,
  type PageReadCapability,
  type PageReadDecision,
} from "../../src/modules/chat/services/pageRead/pageReadDecision.js";
import {
  admitsPageEvidence,
  capturedPageContext,
  pageReadRecordOf,
  type PageReadOutcome,
} from "../../src/modules/chat/services/pageRead/pageReadSessionOutcome.js";
import { pageContextConditionFor } from "../../src/modules/chat/services/pageRead/pageContextCondition.js";

const metadataOnly: PageReadCapability = { available: true, mode: "metadata", supportedOperations: ["metadata"] };
const content: PageReadCapability = { available: true, mode: "content", supportedOperations: ["metadata", "lookup", "summarize"] };
const routine: PageReadCandidate = { source: { kind: "routine", routineId: "booking" }, resolvedRequest: "book this edition" };

const outcomeFor = (input: {
  capability: PageReadCapability | null;
  routineCandidates?: PageReadCandidate[];
  planner?: PageReadDecision | null;
}): PageReadOutcome => {
  const merged = mergePageReadDecision({
    planner: input.planner ?? null,
    routineCandidates: input.routineCandidates ?? [],
    directiveCandidates: [],
    fallbackRequest: "book this edition",
  });
  return { merged, gate: evaluatePageReadGate(merged, input.capability) };
};

const page = {
  pageUrl: "https://example.test/courses/autumn",
  pageTitle: "Autumn retreat",
  pageLocale: "it",
  browserLocale: "it-IT",
  content: "Autumn retreat, 30 Oct to 2 Nov.",
};

describe("capturedPageContext", () => {
  it("stages only the page's identity for a read served as metadata, whatever the request carried", () => {
    const outcome = outcomeFor({ capability: metadataOnly, routineCandidates: [routine] });

    expect(capturedPageContext(outcome, page)).toEqual({
      pageUrl: page.pageUrl,
      pageTitle: page.pageTitle,
      pageLocale: page.pageLocale,
      browserLocale: page.browserLocale,
    });
  });

  it("stages a planner's metadata read as the page's identity too", () => {
    const outcome = outcomeFor({
      capability: content,
      planner: { required: true, operation: "metadata", resolvedRequest: "Which page am I on?" },
    });

    expect(capturedPageContext(outcome, page)).not.toHaveProperty("content");
  });

  it("stages the whole page for a read served from its content", () => {
    expect(capturedPageContext(outcomeFor({ capability: content, routineCandidates: [routine] }), page)).toEqual(page);
  });

  it("stages nothing when the gate captured nothing", () => {
    expect(capturedPageContext(outcomeFor({ capability: null, routineCandidates: [routine] }), page)).toBeNull();
    expect(capturedPageContext(undefined, page)).toBeNull();
  });
});

describe("admitsPageEvidence", () => {
  it("admits a read the turn asked for, the page's identity included", () => {
    expect(admitsPageEvidence(outcomeFor({
      capability: metadataOnly,
      planner: { required: true, operation: "metadata", resolvedRequest: "Which page am I on?" },
    }))).toBe(true);
  });

  it("admits a request for the page as context only once its content was captured", () => {
    expect(admitsPageEvidence(outcomeFor({ capability: content, routineCandidates: [routine] }))).toBe(true);
    expect(admitsPageEvidence(outcomeFor({ capability: metadataOnly, routineCandidates: [routine] }))).toBe(false);
  });

  it("admits the page's identity beside a context request when a contributor asked for it", () => {
    expect(admitsPageEvidence(outcomeFor({
      capability: metadataOnly,
      routineCandidates: [routine],
      planner: { required: true, operation: "metadata", resolvedRequest: "Which page am I on?" },
    }))).toBe(true);
  });

  it("admits nothing without a capture", () => {
    expect(admitsPageEvidence(outcomeFor({ capability: null, routineCandidates: [routine] }))).toBe(false);
    expect(admitsPageEvidence(undefined)).toBe(false);
  });
});

describe("pageReadRecordOf", () => {
  it("records the operation the gate served beside the request", () => {
    expect(pageReadRecordOf(outcomeFor({ capability: metadataOnly, routineCandidates: [routine] }))).toEqual({
      decision: { required: true, operation: "context", resolvedRequest: "book this edition" },
      winnerSource: { kind: "routine", routineId: "booking" },
      gateOutcome: "capture",
      servedOperation: "metadata",
    });
  });

  it("records no served operation when the gate served none", () => {
    expect(pageReadRecordOf(outcomeFor({ capability: null, routineCandidates: [routine] }))).toMatchObject({
      gateOutcome: "unavailable",
      servedOperation: null,
    });
  });
});

describe("pageContextConditionFor beside a request for the page as context", () => {
  it("gives a planner's lookup its unavailable condition when a routine's context read wins on a channel with no page", () => {
    expect(pageContextConditionFor(outcomeFor({
      capability: null,
      routineCandidates: [routine],
      planner: { required: true, operation: "summarize", resolvedRequest: "Summarize this page" },
    }))).toEqual({ kind: "page_context_unavailable", operation: "summarize", resolvedRequest: "Summarize this page" });
  });

  it("gives a planner's content request its unavailable condition when the routine's read got only the identity", () => {
    expect(pageContextConditionFor(outcomeFor({
      capability: metadataOnly,
      routineCandidates: [routine],
      planner: { required: true, operation: "lookup", resolvedRequest: "Find the dates on this page" },
    }))).toEqual({ kind: "page_context_unavailable", operation: "lookup", resolvedRequest: "Find the dates on this page" });
  });

  it("gives a planner's transform its unsupported condition even when the routine's read captured the page", () => {
    expect(pageContextConditionFor(outcomeFor({
      capability: content,
      routineCandidates: [routine],
      planner: { required: true, operation: "transform", resolvedRequest: "Translate this page" },
    }))).toEqual({ kind: "page_operation_unsupported", operation: "transform", resolvedRequest: "Translate this page" });
  });

  it("gives no condition when a planner's request was served alongside the routine's read", () => {
    expect(pageContextConditionFor(outcomeFor({
      capability: metadataOnly,
      routineCandidates: [routine],
      planner: { required: true, operation: "metadata", resolvedRequest: "Which page am I on?" },
    }))).toBeNull();
  });

  it("gives no condition when nothing but a context request asked for the page", () => {
    expect(pageContextConditionFor(outcomeFor({ capability: null, routineCandidates: [routine] }))).toBeNull();
  });
});
