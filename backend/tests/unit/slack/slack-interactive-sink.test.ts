import { describe, expect, it, vi } from "vitest";

import { EmailWebhookOperatorNotificationSink } from "../../../src/modules/chat/services/actions/emailWebhookSink.js";
import type { ContactNotificationMailer } from "../../../src/modules/chat/services/actions/contactSendActionHandler.js";
import { OperatorNotificationDispatcher } from "../../../src/modules/operatorNotifications/public.js";
import { SlackOperatorNotificationSink } from "../../../src/modules/slack/public.js";
import type {
  SlackChannelBindingRecord,
  SlackInstallationRecord,
  SlackPostOutboxPort,
} from "../../../src/modules/slack/public.js";
import type { PendingDecisionRecord } from "../../../src/db/repositories/pendingDecisionRepository.js";

const installation: SlackInstallationRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  connectionId: "conn_1",
  workspaceId: "ws_1",
  teamId: "T1",
  teamName: "Team",
  botUserId: "B1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const binding: SlackChannelBindingRecord = {
  id: "bind_1",
  installationId: installation.id,
  workspaceId: "ws_1",
  answeringAgentId: "agent_1",
  escalationChannelId: "COPS",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const decision = (overrides: Partial<PendingDecisionRecord> = {}): PendingDecisionRecord => ({
  id: "dec_1",
  handle: "pd_1",
  conversationId: "conv_1",
  sessionId: "session_1",
  workspaceId: "ws_1",
  agentId: "agent_1",
  routineId: "routine_1",
  stepId: "step_1",
  reason: "Pick the next branch",
  options: [
    { id: "ship", label: "Ship it" },
    { id: "hold", label: "Hold" },
  ],
  deciderScope: {},
  contentHash: "hash_1",
  status: "pending",
  decision: null,
  decidedBy: null,
  decidedAt: null,
  deadline: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

const notification = {
  kind: "approval" as const,
  workspaceId: "ws_1",
  conversationId: "conv_1",
  agentId: "agent_1",
  handle: "pd_1",
  dashboardPath: "/conversations/conv_1",
};

const handoffNotification = {
  kind: "handoff" as const,
  workspaceId: "ws_1",
  conversationId: "conv_1",
  agentId: "agent_1",
  reason: "Customer asked for a human",
  dashboardPath: "/conversations/conv_1",
};

const createSink = (overrides: {
  installation?: SlackInstallationRecord | null;
  binding?: SlackChannelBindingRecord | null;
  decision?: PendingDecisionRecord | null;
} = {}) => {
  const enqueued: Parameters<SlackPostOutboxPort["enqueue"]>[0][] = [];
  const outbox: SlackPostOutboxPort = {
    enqueue: vi.fn(async (input) => {
      enqueued.push(input);
      return { id: "action_1", duplicate: false };
    }),
  };
  const sink = new SlackOperatorNotificationSink({
    installations: {
      findByWorkspaceId: vi.fn(async () =>
        Object.prototype.hasOwnProperty.call(overrides, "installation") ? overrides.installation! : installation),
    },
    bindings: {
      findByInstallationId: vi.fn(async () =>
        Object.prototype.hasOwnProperty.call(overrides, "binding") ? overrides.binding! : binding),
    },
    pendingDecisions: {
      loadByHandle: vi.fn(async () =>
        Object.prototype.hasOwnProperty.call(overrides, "decision") ? overrides.decision! : decision()),
    },
    outbox,
  });
  return { sink, enqueued };
};

describe("SlackOperatorNotificationSink", () => {
  it("enqueues an operator-channel Slack post with one button per decision option", async () => {
    const { sink, enqueued } = createSink();

    await sink.deliver(notification, {
      requestId: "request_1",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      idempotencyKey: "routine-action:conv_1:approval.request",
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      type: "slack.post",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      idempotencyKey: "slack:operator_notification:decision:pd_1",
      payload: {
        installationId: installation.id,
        channelId: "COPS",
        kind: "operator_notification",
        conversationRef: "conv_1",
      },
    });
    const payload = enqueued[0]!.payload as { blocks: Array<Record<string, unknown>> };
    const actions = payload.blocks.find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements.map((element) => (element.text as { text: string }).text)).toEqual(["Ship it", "Hold"]);
  });

  it("skips Slack when the workspace has no installation", async () => {
    const { sink, enqueued } = createSink({ installation: null });

    await sink.deliver(notification, { requestId: "request_1" });

    expect(enqueued).toHaveLength(0);
  });

  it("skips Slack when no operator channel is configured", async () => {
    const { sink, enqueued } = createSink({ binding: { ...binding, escalationChannelId: null } });

    await sink.deliver(notification, { requestId: "request_1" });

    expect(enqueued).toHaveLength(0);
  });

  it("skips Slack when the pending decision is missing or no longer pending", async () => {
    const missing = createSink({ decision: null });
    await missing.sink.deliver(notification, { requestId: "request_1" });
    expect(missing.enqueued).toHaveLength(0);

    const resolved = createSink({ decision: decision({ status: "resolved" }) });
    await resolved.sink.deliver(notification, { requestId: "request_1" });
    expect(resolved.enqueued).toHaveLength(0);
  });

  it("enqueues an ownership Slack post for handoff notifications", async () => {
    const { sink, enqueued } = createSink();

    await sink.deliver(handoffNotification, {
      requestId: "request_1",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      idempotencyKey: "routine-action:conv_1:handoff.notify",
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      type: "slack.post",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      // Scoped to this handoff event (the per-action idempotency key), so a re-escalation after
      // a hand-back posts again instead of being deduped against the conversation.
      idempotencyKey: "slack:operator_notification:handoff:conv_1:routine-action:conv_1:handoff.notify",
      payload: {
        installationId: installation.id,
        channelId: "COPS",
        kind: "operator_notification",
        conversationRef: "conv_1",
        text: "Customer asked for a human",
      },
    });
    const payload = enqueued[0]!.payload as { blocks: Array<Record<string, unknown>> };
    const actions = payload.blocks.find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements).toHaveLength(1);
    expect(actions.elements[0]).toMatchObject({
      action_id: "ownership_takeover",
      text: { text: "Take over" },
    });
    expect(JSON.parse(actions.elements[0]!.value as string)).toEqual({
      conversationId: "conv_1",
      workspaceId: "ws_1",
    });
  });

  it("skips handoff Slack delivery when the workspace has no installation or operator channel", async () => {
    const missing = createSink({ installation: null });
    await missing.sink.deliver(handoffNotification, { requestId: "request_1" });
    expect(missing.enqueued).toHaveLength(0);

    const noChannel = createSink({ binding: { ...binding, escalationChannelId: null } });
    await noChannel.sink.deliver(handoffNotification, { requestId: "request_1" });
    expect(noChannel.enqueued).toHaveLength(0);
  });

  it("keeps email delivery when the workspace has no Slack installation", async () => {
    const sent: Array<Parameters<ContactNotificationMailer["send"]>[0]> = [];
    const emailSink = new EmailWebhookOperatorNotificationSink(
      { send: async (message) => { sent.push(message); } },
      { resolve: async () => ({ emails: ["owner@business.example"], webhook: null }) },
    );
    const slack = createSink({ installation: null });
    const dispatcher = new OperatorNotificationDispatcher([emailSink, slack.sink]);

    await dispatcher.dispatch(handoffNotification, {
      requestId: "request_1",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      idempotencyKey: "routine-action:conv_1:handoff.notify",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "owner@business.example",
      subject: "Conversation needs a human",
    });
    expect(slack.enqueued).toHaveLength(0);
  });
});
