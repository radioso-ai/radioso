import { describe, expect, it, vi } from "vitest";

import type { ChatReviewInput, ChatReviewResult } from "../../../src/modules/chat/contracts/index.js";
import { SKILL_TURN_OUTCOME } from "../../../src/modules/chat/contracts/index.js";
import { chatReviewResult, reviewTurnFacts } from "../../../src/modules/chat/services/reviewDraft.js";
import {
  parseConversationQualityCases,
  runConversationQualitySuite,
  type ConversationQualityCase,
} from "../../../src/modules/eval/suite/index.js";
import { conversationQualityCases } from "../../fixtures/conversation-quality/cases.js";
import { conversationQualityRoutines } from "../../fixtures/conversation-quality/routines.js";
import { CQ_AGENT_ID, CQ_WORKSPACE_ID, conversationQualityAgentConfig } from "../../fixtures/conversation-quality/index.js";
import { createReviewTurnRunnerPort, createWorkbenchReplayRunnerPort } from "../../../scripts/evalRunnerAdapter.js";
import { needsPublishedAgent, seededRoutineSkillNames } from "../../../scripts/runEvals.js";
import { InMemoryConversationRepository, InMemoryMessageRepository } from "../../support/fakes.js";

// The live conversation-quality runner (scripts/runEvals.ts) drives review cases through
// `ChatService.review()` on the composed stack. These checks stub that one call, so they show
// the adapter's own work: a review case is recorded as an email conversation and reviewed,
// never replayed as a live turn, and the review's facts become the observed output the suite scores.

const PUBLISHED_REVISION_ID = "revision-published";

const grounding = (verdict: "grounded" | "no_support") => ({
  verdict,
  claimCount: verdict === "grounded" ? 1 : 0,
  sourcedClaimCount: verdict === "grounded" ? 1 : 0,
  unsourcedClaimCount: 0,
  invalidSourceCount: 0,
});

/** A review turn's result as `ChatService.review()` builds it, with the given verdicts. */
const reviewedDraft = (
  input: ChatReviewInput,
  verdicts: { grounding: "grounded" | "no_support"; coverage: "answered" | "unanswered" },
): ChatReviewResult => chatReviewResult({
  conversationId: input.conversationId,
  ownershipVersion: 0,
  draft: { text: "A drafted reply.", presentation: { grounding: grounding(verdicts.grounding) } },
  facts: reviewTurnFacts({
    answerOutcome: verdicts.grounding === "grounded" ? "grounded_success" : "no_context_refusal",
    answerCoverage: {
      availability: "assessed",
      coverage: verdicts.coverage,
      originatingTurnId: "turn-1",
      originatingRequestId: input.existingUserMessageId,
    },
    skillOutcome: verdicts.grounding === "grounded"
      ? SKILL_TURN_OUTCOME.RETRIEVAL_GROUNDED.outcome
      : SKILL_TURN_OUTCOME.RETRIEVAL_NO_CONTEXT.outcome,
    ownershipHandoff: null,
    suppressedEffects: [],
    citationCount: verdicts.grounding === "grounded" ? 1 : 0,
  }),
});

const liveStack = () => {
  const conversations = new InMemoryConversationRepository();
  const messages = new InMemoryMessageRepository();
  const replay = { run: vi.fn(async () => { throw new Error("a review case must not run as a live turn"); }) };
  return { conversations, messages, replay };
};

const reviewPortOver = (
  stack: ReturnType<typeof liveStack>,
  review: (input: ChatReviewInput) => Promise<ChatReviewResult>,
) => ({
  ...createWorkbenchReplayRunnerPort(stack.replay, {
    workspaceId: CQ_WORKSPACE_ID,
    agentId: CQ_AGENT_ID,
    baselineAgentConfig: conversationQualityAgentConfig,
  }),
  ...createReviewTurnRunnerPort(
    { chat: { review: vi.fn(review) }, conversations: stack.conversations, messages: stack.messages },
    { workspaceId: CQ_WORKSPACE_ID, agentId: CQ_AGENT_ID, agentRevisionId: PUBLISHED_REVISION_ID },
  ),
});

const reviewCase = (overrides: Partial<ConversationQualityCase> = {}): ConversationQualityCase => ({
  id: "review-case",
  name: "a review case",
  executionMode: "review",
  query: "Can I still get a refund?",
  assertions: [{ type: "turn_persists_no_reply" }],
  ...overrides,
});

describe("live conversation-quality runner, review cases", () => {
  it("scores the committed email review cases through the review turn, not the live replay", async () => {
    const emailCases = parseConversationQualityCases(conversationQualityCases)
      .filter((evalCase) => evalCase.executionMode === "review");
    expect(emailCases.map((evalCase) => evalCase.id)).toEqual([
      "email-review-covered-refund",
      "email-review-uncovered-nonprofit-discount",
    ]);
    const stack = liveStack();
    const port = reviewPortOver(stack, async (input) => {
      const request = await stack.messages.findByIdAndWorkspaceId(input.workspaceId, input.existingUserMessageId);
      const covered = request?.content.includes("refund") ?? false;
      return reviewedDraft(input, covered
        ? { grounding: "grounded", coverage: "answered" }
        : { grounding: "no_support", coverage: "unanswered" });
    });

    const { reports } = await runConversationQualitySuite(emailCases, port, { workspaceId: CQ_WORKSPACE_ID });

    expect(reports.map((report) => [report.caseId, report.status])).toEqual([
      ["email-review-covered-refund", "pass"],
      ["email-review-uncovered-nonprofit-discount", "pass"],
    ]);
    expect(stack.replay.run).not.toHaveBeenCalled();
  });

  it("records the case as an email conversation on the published revision and reviews its customer message", async () => {
    const stack = liveStack();
    const reviews: ChatReviewInput[] = [];
    const port = reviewPortOver(stack, async (input) => {
      reviews.push(input);
      return reviewedDraft(input, { grounding: "grounded", coverage: "answered" });
    });

    await port.review(reviewCase({
      history: [
        { role: "user", content: "Hello, I have a question about my plan." },
        { role: "assistant", content: "Of course, what would you like to know?" },
      ],
    }));

    expect(reviews).toHaveLength(1);
    const [review] = reviews;
    expect(review).toMatchObject({ workspaceId: CQ_WORKSPACE_ID, agentId: CQ_AGENT_ID, historyWindow: { maxMessages: 2 } });
    const conversation = await stack.conversations.findByIdAndWorkspaceId(review.conversationId, CQ_WORKSPACE_ID);
    expect(conversation).toMatchObject({ sourceChannel: "email", agentId: CQ_AGENT_ID, agentRevisionId: PUBLISHED_REVISION_ID });
    const recorded = await stack.messages.listByConversationId(CQ_WORKSPACE_ID, review.conversationId);
    expect(recorded.map((message) => [message.role, message.content])).toEqual([
      ["user", "Hello, I have a question about my plan."],
      ["assistant", "Of course, what would you like to know?"],
      ["user", "Can I still get a refund?"],
    ]);
    expect(recorded[2].id).toBe(review.existingUserMessageId);
  });

  it("maps the draft's grounding, the facts' coverage, and the replies the conversation gained", async () => {
    const stack = liveStack();
    const port = reviewPortOver(stack, async (input) => {
      // A review turn that wrongly persisted its reply, which `turn_persists_no_reply` must catch.
      await stack.messages.create({ conversationId: input.conversationId, workspaceId: input.workspaceId, role: "assistant", content: "sent" });
      return reviewedDraft(input, { grounding: "grounded", coverage: "answered" });
    });

    const observed = await port.review(reviewCase());

    expect(observed).toMatchObject({
      answer: "A drafted reply.",
      groundingVerdict: "grounded",
      reviewTurn: { answerCoverage: { availability: "assessed", coverage: "answered" }, persistedAssistantMessageCount: 1 },
    });
  });

  it("reports no answer and no coverage when the turn produced no draft", async () => {
    const stack = liveStack();
    const port = reviewPortOver(stack, async (input) => ({
      kind: "no_draft",
      conversationId: input.conversationId,
      ownershipVersion: 0,
      facts: reviewTurnFacts({
        answerOutcome: undefined,
        answerCoverage: undefined,
        skillOutcome: SKILL_TURN_OUTCOME.RETRIEVAL_UNAVAILABLE.outcome,
        ownershipHandoff: null,
        suppressedEffects: [],
        citationCount: 0,
      }),
    }));

    const observed = await port.review(reviewCase());

    expect(observed.answer).toBeUndefined();
    expect(observed.groundingVerdict).toBeUndefined();
    expect(observed.reviewTurn).toEqual({ answerCoverage: null, persistedAssistantMessageCount: 0 });
  });

  it("scores a conversation a person owns as a runner error, since no review turn ran", async () => {
    const stack = liveStack();
    const port = reviewPortOver(stack, async (input) => ({ kind: "human_owned", conversationId: input.conversationId, ownershipVersion: 1 }));

    const observed = await port.review(reviewCase());

    expect(observed.error?.message).toMatch(/person owns the conversation/);
  });
});

describe("live conversation-quality runner, seeded agent", () => {
  // Review cases run the published revision, and publishing refuses a routine whose tool step
  // names a skill the agent lacks. The runner holds those skills on the agent while it publishes,
  // so a routine that dispatches a skill it does not cover would fail every run with a review case.
  it("publishes the agent only for a run that selects a review case", () => {
    const committed = parseConversationQualityCases(conversationQualityCases);

    expect(needsPublishedAgent(committed)).toBe(true);
    expect(needsPublishedAgent(committed.filter((evalCase) => (evalCase.tags ?? []).includes("email")))).toBe(true);
    expect(needsPublishedAgent(committed.filter((evalCase) => evalCase.executionMode !== "review"))).toBe(false);
  });

  it("holds every skill a seeded routine dispatches while it publishes, so the seeded agent can be published", () => {
    const dispatched = conversationQualityRoutines.flatMap((routine) =>
      routine.steps.flatMap((step) => (step.kind === "tool" && step.toolRef ? [step.toolRef] : [])));

    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.filter((skillName) => !seededRoutineSkillNames.includes(skillName))).toEqual([]);
  });
});
