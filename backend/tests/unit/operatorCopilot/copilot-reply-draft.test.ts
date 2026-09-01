import { describe, expect, it, vi } from "vitest";

import { copilotNeverList } from "../../../src/modules/operatorCopilot/neverList.js";
import { ReplyDraftProbeService } from "../../../src/modules/operatorCopilot/services/replyDraftProbeService.js";
import { createReplyDraftCopilotTools } from "../../../src/modules/operatorCopilot/tools/replyDraft.js";

const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  copilotConversationId: "copilot-conversation-1",
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "activity" as const, agentId: null, conversationId: CONVERSATION_ID, selection: null, entities: [] },
};

const port = (overrides: Record<string, unknown> = {}) => ({
  draft: vi.fn(async () => ({
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    draft: "We reissued the parcel this morning.",
    citations: [{ documentId: "document-1" }],
    groundedOnMessageCount: 6,
    ...overrides,
  })),
});

describe("draft_reply", () => {
  it("declares a probe that carries the grant for working a live conversation", () => {
    const [descriptor] = createReplyDraftCopilotTools({ replyDraft: port() });

    expect(descriptor).toMatchObject({
      name: "draft_reply",
      // Not a proposal: a proposal's apply path would be the send, which is the boundary.
      shape: "probe",
      contributingModule: "chat",
      requiredPermissions: ["workspace.history.read", "workspace.conversation.takeover"],
      dashboardSubject: { type: "conversation" },
    });
    expect(descriptor!.verificationCost({} as never)).toBeGreaterThan(0);
  });

  it("drafts for the conversation on screen and hands back text nobody has been sent", async () => {
    const replyDraft = port();
    const [descriptor] = createReplyDraftCopilotTools({ replyDraft });

    const result = await descriptor!.createTool(context).invoke({}, {} as never);

    expect(replyDraft.draft).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      conversationId: CONVERSATION_ID,
      copilotConversationId: "copilot-conversation-1",
    }));
    expect(result).toEqual({
      draft: {
        conversationId: CONVERSATION_ID,
        agentId: AGENT_ID,
        text: "We reissued the parcel this morning.",
        citations: [{ documentId: "document-1" }],
        groundedOnMessageCount: 6,
      },
    });
  });

  it("keeps sending, ownership, and decision resolution on the never-list", () => {
    expect(Object.keys(copilotNeverList)).toEqual(expect.arrayContaining([
      "unattended_live_customer_reply",
      "live_conversation_ownership",
      "pending_decision_resolution",
    ]));
  });
});

describe("ReplyDraftProbeService", () => {
  const dependencies = (chatReplyDraft = {
    draftReply: vi.fn(async () => ({
      agentId: AGENT_ID,
      draft: "We reissued the parcel this morning.",
      citations: [],
      groundedOnMessageCount: 4,
    })),
  }) => ({
    chatReplyDraft,
    abuseControl: { enforce: vi.fn(async () => undefined) },
    audit: { record: vi.fn(async () => undefined) },
    abusePolicy: { limit: 5, windowMs: 60_000 },
  });

  it("spends the operator's expensive-operation budget before composing", async () => {
    const deps = dependencies();
    const service = new ReplyDraftProbeService(deps as never);

    await service.draft({
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      copilotConversationId: "copilot-conversation-1",
      conversationId: CONVERSATION_ID,
    });

    expect(deps.abuseControl.enforce).toHaveBeenCalled();
    expect(deps.chatReplyDraft.draftReply).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      conversationId: CONVERSATION_ID,
    }));
  });

  it("does not compose when the operator is over the probe rate limit", async () => {
    const deps = dependencies();
    deps.abuseControl.enforce = vi.fn(async () => {
      throw Object.assign(new Error("Please wait before trying again"), { statusCode: 429, details: { retryAfterSeconds: 30 } });
    });
    const service = new ReplyDraftProbeService(deps as never);

    await expect(service.draft({
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      copilotConversationId: "copilot-conversation-1",
      conversationId: CONVERSATION_ID,
    })).rejects.toThrow(/rate limit/i);
    expect(deps.chatReplyDraft.draftReply).not.toHaveBeenCalled();
  });
});
