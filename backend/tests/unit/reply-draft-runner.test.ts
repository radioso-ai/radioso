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
  return {
    opts,
    result: runner.draftReply({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      historyLimit: 20,
      usageAttribution: { surface: "operator_copilot_reply_draft", requestId: "copilot-conversation-1" },
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

  it("refuses when the last turn is not a waiting customer message", async () => {
    const { opts, result } = draft({
      messages: { listRecentByConversationId: vi.fn(async () => [transcript[0]!, transcript[1]!]) },
    } as Partial<ReplyDraftRunnerOptions>);

    await expect(result).rejects.toThrow(/customer message/i);
    expect(opts.replay.run).not.toHaveBeenCalled();
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
