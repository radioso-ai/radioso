import { describe, expect, it, vi } from "vitest";

import { ReplyDraftRunner } from "../../src/modules/chat/services/replyDraftRunner.js";
import type { ReplyDraftRunnerOptions } from "../../src/modules/chat/services/replyDraftRunner.js";

const WORKSPACE_ID = "workspace-1";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const message = (role: "user" | "assistant", content: string, minute: number) => ({
  id: `message-${minute}`,
  conversationId: CONVERSATION_ID,
  workspaceId: WORKSPACE_ID,
  role,
  content,
  createdAt: new Date(`2026-08-26T09:${String(minute).padStart(2, "0")}:00.000Z`),
});

const summaryRecord = (summary: string) => ({
  summary,
  coveredMessageCount: 2,
  coveredThrough: new Date("2026-08-26T09:01:00.000Z"),
});

const transcript = [
  message("user", "My order never arrived.", 0),
  message("assistant", "Let me check that for you.", 1),
  message("user", "It has been three weeks now.", 2),
];

const options = (overrides: Partial<ReplyDraftRunnerOptions> = {}): ReplyDraftRunnerOptions => ({
  conversations: {
    findByIdAndWorkspaceId: vi.fn(async () => ({
      id: CONVERSATION_ID,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
    })),
  },
  messages: { listRecentByConversationId: vi.fn(async () => transcript) },
  agentConfig: { resolveConfig: vi.fn(async () => ({ name: "Support" })) },
  summaries: { load: vi.fn(async () => summaryRecord("The customer is chasing a parcel from three weeks ago.")) },
  routineStates: { loadActive: vi.fn(async () => null) },
  replay: {
    run: vi.fn(async () => ({
      answer: "We reissued the parcel this morning.",
      citations: [{ documentId: "document-1" }],
      resolvedConfig: {},
    })),
  },
  ...overrides,
} as unknown as ReplyDraftRunnerOptions);

const draft = (overrides: Partial<ReplyDraftRunnerOptions> = {}) => {
  const opts = options(overrides);
  const runner = new ReplyDraftRunner(opts);
  const reserve = vi.fn(async () => undefined);
  return {
    opts,
    reserve,
    result: runner.draftReply({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      historyLimit: 20,
      usageAttribution: { surface: "operator_copilot_reply_draft", requestId: "copilot-conversation-1" },
      reserve,
    }),
  };
};

describe("ReplyDraftRunner", () => {
  it("replays the agent over the conversation's own transcript and persists nothing", async () => {
    const { opts, result } = draft();

    await expect(result).resolves.toMatchObject({
      agentId: AGENT_ID,
      draft: "We reissued the parcel this morning.",
      citations: [{ documentId: "document-1" }],
      groundedOnMessageCount: 3,
    });
    // The waiting customer message is the query; everything before it is context. Passing the whole
    // transcript as history would leave the runner with nothing to answer.
    expect(opts.replay.run).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      sourceAgentId: AGENT_ID,
      query: "It has been three weeks now.",
      history: transcript.slice(0, 2),
    }));
  });

  it("composes in safe-test mode, so the drafting turn cannot act on the customer's behalf", async () => {
    // The ephemeral effect profile stops every write, and this stops every skill that reaches
    // outside it: a notify, a webhook, a contact send, an external MCP tool. Drafting a reply must
    // not refund an order. Deleting this line leaves every other test in the file passing.
    const { opts, result } = draft();

    await result;

    expect(opts.replay.run).toHaveBeenCalledWith(expect.objectContaining({ executionMode: "safe_test" }));
  });

  it("threads the rolling summary so the draft answers from the memory the agent has", async () => {
    const { opts, result } = draft();

    await expect(result).resolves.toMatchObject({ groundedOnSummary: true });
    expect(opts.summaries.load).toHaveBeenCalledWith({ sessionId: CONVERSATION_ID });
    expect(opts.replay.run).toHaveBeenCalledWith(expect.objectContaining({
      conversationSummary: "The customer is chasing a parcel from three weeks ago.",
    }));
  });

  it("says so when the conversation has no summary yet, rather than implying full grounding", async () => {
    const { result } = draft({ summaries: { load: vi.fn(async () => null) } } as Partial<ReplyDraftRunnerOptions>);

    await expect(result).resolves.toMatchObject({ groundedOnSummary: false });
  });

  it("refuses when the last turn is not a waiting customer message", async () => {
    const { opts, reserve, result } = draft({
      messages: { listRecentByConversationId: vi.fn(async () => [transcript[0]!, transcript[1]!]) },
    } as Partial<ReplyDraftRunnerOptions>);

    await expect(result).rejects.toThrow(/customer message/i);
    expect(opts.replay.run).not.toHaveBeenCalled();
    // A conversation that cannot be drafted for costs nothing: the allowance is claimed at
    // dispatch, so a refusal never spends one and never comes back as a quota error.
    expect(reserve).not.toHaveBeenCalled();
  });

  it("claims the allowance only once the turn is about to run", async () => {
    const { reserve, result } = draft();

    await result;

    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("resumes the routine the conversation is part-way through", async () => {
    // Every approval row in the operator queue is a conversation paused mid-routine. Drafting for
    // one without its position answers as if the routine had never started.
    const position = { routineId: "routine-1", stepId: "collect_address", slots: {}, status: "active" };
    const { opts, result } = draft({
      routineStates: { loadActive: vi.fn(async () => ({ sessionId: CONVERSATION_ID, ...position })) },
    } as unknown as Partial<ReplyDraftRunnerOptions>);

    await expect(result).resolves.toMatchObject({ groundedOnRoutine: true });
    expect(opts.replay.run).toHaveBeenCalledWith(expect.objectContaining({ routineStartState: position }));
  });

  it("says so when the conversation is in no routine", async () => {
    const { opts, result } = draft();

    await expect(result).resolves.toMatchObject({ groundedOnRoutine: false });
    expect(opts.replay.run).toHaveBeenCalledWith(expect.objectContaining({ routineStartState: null }));
  });

  it("degrades to no summary when the summary store fails, rather than failing the draft", async () => {
    // The live turn's policy: a broken summary read leaves the turn on its recent-message window.
    const { result } = draft({
      summaries: { load: vi.fn(async () => { throw new Error("summary store unavailable"); }) },
      logger: { warn: vi.fn() },
    } as Partial<ReplyDraftRunnerOptions>);

    await expect(result).resolves.toMatchObject({ groundedOnSummary: false });
  });

  it("treats a blank stored summary as no summary", async () => {
    const { opts, result } = draft({
      summaries: { load: vi.fn(async () => summaryRecord("   ")) },
    } as Partial<ReplyDraftRunnerOptions>);

    await expect(result).resolves.toMatchObject({ groundedOnSummary: false });
    expect(opts.replay.run).toHaveBeenCalledWith(expect.objectContaining({ conversationSummary: null }));
  });

  it("refuses a conversation outside the workspace", async () => {
    const { opts, result } = draft({
      conversations: { findByIdAndWorkspaceId: vi.fn(async () => null) },
    } as Partial<ReplyDraftRunnerOptions>);

    await expect(result).rejects.toThrow(/not found/i);
    expect(opts.replay.run).not.toHaveBeenCalled();
  });

  it("refuses a conversation with no agent to speak for", async () => {
    const { opts, result } = draft({
      conversations: {
        findByIdAndWorkspaceId: vi.fn(async () => ({ id: CONVERSATION_ID, workspaceId: WORKSPACE_ID, agentId: null })),
      },
    } as Partial<ReplyDraftRunnerOptions>);

    await expect(result).rejects.toThrow(/agent/i);
    expect(opts.replay.run).not.toHaveBeenCalled();
  });

  it("refuses when the agent's configuration cannot be resolved", async () => {
    const { opts, result } = draft({
      agentConfig: { resolveConfig: vi.fn(async () => null) },
    } as Partial<ReplyDraftRunnerOptions>);

    await expect(result).rejects.toThrow(/agent/i);
    expect(opts.replay.run).not.toHaveBeenCalled();
  });
});
