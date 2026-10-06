import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { ReviewTurnAuditReader } from "../../../src/modules/chat/contracts/index.js";
import { InMemoryAuditEventRepository } from "../../support/fakes.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const OTHER_CONVERSATION = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const OTHER_REQUEST = "55555555-5555-4555-8555-555555555555";
const TURN = "66666666-6666-4666-8666-666666666666";
const LATER_TURN = "77777777-7777-4777-8777-777777777777";
const DRAFT = "SENTINEL-draft-text";

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 6, 9, minute));

const setup = () => {
  const audit = new InMemoryAuditEventRepository();
  const record = (createdAt: Date, metadata: Record<string, unknown>, overrides: { eventStatus?: string; workspaceId?: string } = {}) => {
    audit.items.push({
      id: randomUUID(),
      accountId: null,
      workspaceId: overrides.workspaceId ?? WORKSPACE,
      eventType: "chat.answer",
      eventStatus: overrides.eventStatus ?? "success",
      metadata: { conversationId: CONVERSATION, ...metadata },
      createdAt,
    });
  };
  /** A review turn's audit as the review completion records it. */
  const review = (createdAt: Date, metadata: Record<string, unknown> = {}, overrides: { eventStatus?: string; workspaceId?: string } = {}) =>
    record(createdAt, {
      executionMode: "review",
      surface: "email",
      userMessageId: REQUEST,
      requestMessageId: REQUEST,
      turnId: TURN,
      answerOutcome: "grounded_success",
      groundingVerdict: "grounded",
      ...metadata,
    }, overrides);
  const listSpy = vi.spyOn(audit, "listChatAnswerEventsByConversationId");
  return { reader: new ReviewTurnAuditReader(audit), record, review, listSpy };
};

describe("ReviewTurnAuditReader", () => {
  it("reads the review turn that answered a message: its id, answer outcome and grounding verdict", async () => {
    const { reader, record, review } = setup();
    record(at(1), { userMessageId: REQUEST, assistantMessageId: randomUUID(), answerOutcome: "no_context_refusal", groundingVerdict: "no_support" });
    review(at(2));
    review(at(3), { requestMessageId: OTHER_REQUEST, userMessageId: OTHER_REQUEST, turnId: LATER_TURN, answerOutcome: "coverage_partial" });
    review(at(4), {}, { eventStatus: "failure" });

    const [found] = await reader.find(WORKSPACE, [{ conversationId: CONVERSATION, requestMessageId: REQUEST, recordedBy: at(10) }]);

    expect(found).toEqual({ turnId: TURN, answerOutcome: "grounded_success", groundingVerdict: "grounded" });
  });

  it("takes the newest review of the message recorded by the time the reply was held, not a later one", async () => {
    const { reader, review } = setup();
    review(at(1), { turnId: randomUUID(), answerOutcome: "coverage_unclear" });
    review(at(2), { answerOutcome: "coverage_partial" });
    review(at(5), { turnId: LATER_TURN, answerOutcome: "no_context_refusal" });

    const [found] = await reader.find(WORKSPACE, [{ conversationId: CONVERSATION, requestMessageId: REQUEST, recordedBy: at(2) }]);

    expect(found).toEqual({ turnId: TURN, answerOutcome: "coverage_partial", groundingVerdict: "grounded" });
  });

  it("reads codes only: a field that is not one of its kind's codes reads null, and nothing else comes back", async () => {
    const { reader, review } = setup();
    review(at(1), {
      answerOutcome: { text: DRAFT },
      groundingVerdict: DRAFT,
      answerSegments: [{ text: DRAFT }],
      turnTrace: { answer: { text: DRAFT } },
    });

    const [found] = await reader.find(WORKSPACE, [{ conversationId: CONVERSATION, requestMessageId: REQUEST, recordedBy: at(2) }]);

    expect(found).toEqual({ turnId: TURN, answerOutcome: null, groundingVerdict: null });
    expect(JSON.stringify(found)).not.toContain(DRAFT);
  });

  it("answers null without a review record, for another workspace's, or one with no turn id", async () => {
    const { reader, review } = setup();
    review(at(1), {}, { workspaceId: randomUUID() });
    review(at(1), { requestMessageId: OTHER_REQUEST, turnId: DRAFT });

    expect(await reader.find(WORKSPACE, [
      { conversationId: CONVERSATION, requestMessageId: REQUEST, recordedBy: at(2) },
      { conversationId: CONVERSATION, requestMessageId: OTHER_REQUEST, recordedBy: at(2) },
    ])).toEqual([null, null]);
  });

  it("reads each conversation once for a page of held replies, answering in the order asked", async () => {
    const { reader, review, listSpy } = setup();
    review(at(1));
    review(at(1), { conversationId: OTHER_CONVERSATION, requestMessageId: OTHER_REQUEST, turnId: LATER_TURN });

    const found = await reader.find(WORKSPACE, [
      { conversationId: OTHER_CONVERSATION, requestMessageId: OTHER_REQUEST, recordedBy: at(2) },
      { conversationId: CONVERSATION, requestMessageId: REQUEST, recordedBy: at(2) },
      { conversationId: CONVERSATION, requestMessageId: OTHER_REQUEST, recordedBy: at(2) },
    ]);

    expect(found.map((entry) => entry?.turnId ?? null)).toEqual([LATER_TURN, TURN, null]);
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(await reader.find(WORKSPACE, [])).toEqual([]);
  });
});
