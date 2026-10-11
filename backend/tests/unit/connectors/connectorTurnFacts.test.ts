import { describe, expect, it } from "vitest";

import type { AnswerCoverageAvailability } from "@radioso/conversation-contract";
import type { ConnectorTurnFacts } from "@radioso/connector-api";

import type { ChatReviewResult, ReviewTurnFactsSource } from "../../../src/modules/chat/contracts/index.js";
import {
  connectorTurnFacts,
  connectorTurnResult,
} from "../../../src/modules/connectors/services/connectorTurnFacts.js";
import { ASSISTANT_TURN_OUTCOME, type AssistantTurnOutcome } from "../../../src/modules/chat/services/assistantTurnOutcomeTypes.js";
import { reviewedTurnFixture } from "../../support/reviewTurnFixtures.js";

const facts = (overrides: Partial<ReviewTurnFactsSource> = {}): ReviewTurnFactsSource => ({
  answerOutcome: "grounded_success",
  answerCoverage: null,
  skillOutcome: "grounded",
  ownershipHandoffSignal: null,
  suppressedEffects: [],
  citationCount: 0,
  ...overrides,
});

const assessed = (coverage: "answered" | "partial" | "unanswered" | "unclear") => ({
  availability: "assessed" as const,
  coverage,
  reason: "sufficient_evidence" as const,
  originatingTurnId: "request-message",
  originatingRequestId: "request-message",
});

const unassessed = (availability: Exclude<AnswerCoverageAvailability, "assessed">) => ({
  availability,
  originatingTurnId: "request-message",
  originatingRequestId: "request-message",
});

const draftFacts = (result: ChatReviewResult): ConnectorTurnFacts => {
  const mapped = connectorTurnResult(result);
  if (mapped.kind === "human_owned") {
    throw new Error("expected turn facts");
  }
  return mapped.facts;
};

describe("connectorTurnFacts grounding", () => {
  // Keyed by every outcome, so a new outcome fails to compile until its row is pinned here.
  const GROUNDING: Record<AssistantTurnOutcome, ConnectorTurnFacts["grounding"]> = {
    grounded_success: "grounded",
    coverage_partial: "grounded",
    no_context_refusal: "ungrounded",
    coverage_unanswered: "ungrounded",
    non_retrieval_response: "not_applicable",
    coverage_unclear: "unknown",
    coverage_unavailable: "unknown",
  };

  it.each(Object.values(ASSISTANT_TURN_OUTCOME))("maps %s", (answerOutcome) => {
    expect(connectorTurnFacts(facts({ answerOutcome }), "draft").grounding).toBe(GROUNDING[answerOutcome]);
  });

  it("is unknown when the turn recorded no outcome", () => {
    expect(connectorTurnFacts(facts({ answerOutcome: null }), "draft").grounding).toBe("unknown");
  });

  it("is unknown for an outcome it does not recognise", () => {
    const unrecognised = facts({ answerOutcome: "grounded_eventually" as AssistantTurnOutcome });

    expect(connectorTurnFacts(unrecognised, "draft").grounding).toBe("unknown");
  });
});

describe("connectorTurnFacts coverage", () => {
  it.each(["answered", "partial", "unanswered", "unclear"] as const)("narrows an assessed record to %s", (coverage) => {
    expect(connectorTurnFacts(facts({ answerCoverage: assessed(coverage) }), "draft").coverage).toBe(coverage);
  });

  it.each([
    ["not_recorded", "not_assessed"],
    ["failed", "unavailable"],
    ["invalid", "unavailable"],
  ] as const)("maps availability %s to %s", (availability, expected) => {
    expect(connectorTurnFacts(facts({ answerCoverage: unassessed(availability) }), "draft").coverage).toBe(expected);
  });

  it("is not assessed when the turn has no coverage record", () => {
    expect(connectorTurnFacts(facts({ answerCoverage: null }), "draft").coverage).toBe("not_assessed");
  });

  it("fails closed on an assessed record that carries no coverage value", () => {
    const malformed = facts({ answerCoverage: { ...unassessed("not_recorded"), availability: "assessed" } });

    expect(connectorTurnFacts(malformed, "draft").coverage).toBe("unavailable");
  });
});

describe("connectorTurnFacts hand-off, outcome and effects", () => {
  it("reports the hand-off the turn asked for", () => {
    const mapped = connectorTurnFacts(facts({ ownershipHandoffSignal: { reason: "retrieval_miss" } }), "draft");

    expect(mapped.handoff).toEqual({ requested: true, reason: "retrieval_miss" });
  });

  it("reports no hand-off on a draft that asked for none", () => {
    expect(connectorTurnFacts(facts(), "draft").handoff).toEqual({ requested: false });
  });

  it("asks for a person with review_unavailable when there is no draft and no hand-off", () => {
    expect(connectorTurnFacts(facts(), "no_draft").handoff).toEqual({ requested: true, reason: "review_unavailable" });
  });

  it("keeps the engine's reason when there is no draft", () => {
    const mapped = connectorTurnFacts(facts({ ownershipHandoffSignal: { reason: "routine_handoff" } }), "no_draft");

    expect(mapped.handoff).toEqual({ requested: true, reason: "routine_handoff" });
  });

  it.each([
    ["grounded", "answered"],
    ["conversational", "answered"],
    ["no_context", "no_context"],
    ["out_of_scope", "out_of_scope"],
    ["unavailable", "unavailable"],
  ] as const)("maps skill outcome %s to %s", (skillOutcome, outcome) => {
    expect(connectorTurnFacts(facts({ skillOutcome }), "draft").outcome).toBe(outcome);
  });

  it("names suppressed effects by skill only and counts citations", () => {
    const mapped = connectorTurnFacts(facts({
      suppressedEffects: [{ skillName: "order_lookup", site: "turn" }, { skillName: "grounded_search", site: "staged_tool" }],
      citationCount: 2,
    }), "draft");

    expect(mapped.suppressedEffects).toEqual([{ skillName: "order_lookup" }, { skillName: "grounded_search" }]);
    expect(mapped.citationCount).toBe(2);
  });
});

describe("connectorTurnFacts on review turns completed by the lifecycle", () => {
  it("maps a grounded, answered, effect-free draft to publishable facts", async () => {
    const result = await reviewedTurnFixture({
      presentation: {
        citations: [{ chunkId: "chunk-1", documentId: "doc-1", title: "Shipping" }],
      },
      answerCoverage: assessed("answered"),
    });

    expect(draftFacts(result)).toEqual({
      outcome: "answered",
      grounding: "grounded",
      coverage: "answered",
      handoff: { requested: false },
      suppressedEffects: [],
      citationCount: 1,
    });
  });

  it("maps a partial answer with a suppressed effect", async () => {
    const result = await reviewedTurnFixture({
      presentation: { answerOutcome: "coverage_partial" },
      answerCoverage: assessed("partial"),
      suppressedEffects: [{ skillName: "order_lookup", site: "turn" }],
    });

    expect(draftFacts(result)).toMatchObject({
      grounding: "grounded",
      coverage: "partial",
      suppressedEffects: [{ skillName: "order_lookup" }],
    });
  });

  it("maps a no-context hand-off turn", async () => {
    const result = await reviewedTurnFixture({
      presentation: { answer: "Let me find a teammate.", skillOutcome: "no_context", answerOutcome: "no_context_refusal" },
      answerCoverage: assessed("unanswered"),
      ownershipHandoff: { reason: "retrieval_miss" },
    });

    expect(result.kind).toBe("draft");
    expect(draftFacts(result)).toMatchObject({
      outcome: "no_context",
      grounding: "ungrounded",
      coverage: "unanswered",
      handoff: { requested: true, reason: "retrieval_miss" },
    });
  });

  it("maps a conversational turn with no coverage record", async () => {
    const result = await reviewedTurnFixture({
      presentation: {
        answer: "Hello! How can I help?",
        skillName: "assistant.chat",
        skillOutcome: "conversational",
        answerOutcome: undefined,
      },
    });

    expect(draftFacts(result)).toMatchObject({ outcome: "answered", grounding: "not_applicable", coverage: "not_assessed" });
  });

  it("maps an unavailable turn to no draft that asks for a person", async () => {
    const result = await reviewedTurnFixture({
      presentation: { answer: "I can't respond right now.", skillOutcome: "unavailable", skillStatus: "failed", answerOutcome: "coverage_unavailable" },
      answerCoverage: unassessed("failed"),
    });

    expect(result.kind).toBe("no_draft");
    expect(draftFacts(result)).toEqual({
      outcome: "unavailable",
      grounding: "unknown",
      coverage: "unavailable",
      handoff: { requested: true, reason: "review_unavailable" },
      suppressedEffects: [],
      citationCount: 0,
    });
  });
});
