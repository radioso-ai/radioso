import { describe, expect, it, vi } from "vitest";

import { EmailWebhookOperatorNotificationSink } from "../../../src/modules/chat/services/actions/emailWebhookSink.js";
import { buildHandoffNotifyAction } from "../../../src/modules/chat/services/handoffOwnership.js";
import type {
  ContactNotificationMailer,
  ContactWebhookHttpClient,
} from "../../../src/modules/chat/services/actions/contactSendActionHandler.js";
import { formatRoutineEndingNotification, routineEndingNotificationFromAction } from "../../../src/modules/operatorNotifications/public.js";

type SentMessage = Parameters<ContactNotificationMailer["send"]>[0];
type WebhookRequest = Parameters<ContactWebhookHttpClient["post"]>[0];

const notification = {
  kind: "approval" as const,
  workspaceId: "ws_1",
  conversationId: "conv_1",
  agentId: "agent_1",
  handle: "pd_abc",
};

const handoffNotification = {
  kind: "handoff" as const,
  workspaceId: "ws_1",
  conversationId: "conv_1",
  agentId: "agent_1",
  reason: "routine_handoff",
};

const context = {
  requestId: "request_1",
  workspaceId: "ws_1",
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:approval.request",
};

const recordingMailer = (): { mailer: ContactNotificationMailer; sent: SentMessage[] } => {
  const sent: SentMessage[] = [];
  return { mailer: { send: async (message) => { sent.push(message); } }, sent };
};

const recordingWebhookClient = (): { httpClient: ContactWebhookHttpClient; requests: WebhookRequest[] } => {
  const requests: WebhookRequest[] = [];
  return {
    httpClient: {
      post: async (request) => {
        requests.push(request);
      },
    },
    requests,
  };
};

describe("EmailWebhookOperatorNotificationSink", () => {
  it("links the operator straight to the conversation permalink", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: ["owner@business.example"], webhook: null }) },
      undefined,
      undefined,
      { resolve: async () => "https://app.radioso.ai/w/support-abc/activity?tab=all&filter=chat&itemKind=chat&itemId=conv_1" },
    );

    await sink.deliver(notification, context);

    expect(sent[0].text).toContain(
      "Open: https://app.radioso.ai/w/support-abc/activity?tab=all&filter=chat&itemKind=chat&itemId=conv_1",
    );
  });

  it("asks the resolver for the notification's own workspace and conversation", async () => {
    const { mailer } = recordingMailer();
    const resolve = vi.fn(async () => "https://app.radioso.ai/w/support-abc/activity");
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: ["owner@business.example"], webhook: null }) },
      undefined,
      undefined,
      { resolve },
    );

    await sink.deliver(handoffNotification, context);

    expect(resolve).toHaveBeenCalledWith({ workspaceId: "ws_1", conversationId: "conv_1" });
  });

  it("omits the link rather than sending a broken one when the workspace cannot be resolved", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: ["owner@business.example"], webhook: null }) },
      undefined,
      undefined,
      { resolve: async () => null },
    );

    await sink.deliver(notification, context);

    expect(sent[0].text).not.toContain("Open:");
    // The message still has to be actionable without a link.
    expect(sent[0].text).toContain("Conversation: conv_1");
  });

  it("still delivers the mail when resolving the link fails", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: ["owner@business.example"], webhook: null }) },
      undefined,
      undefined,
      { resolve: async () => { throw new Error("workspace lookup failed"); } },
    );

    await sink.deliver(notification, context);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).not.toContain("Open:");
  });

  it("preserves approval email delivery", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await sink.deliver(notification, context);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@business.example");
    expect(sent[0].subject).toBe("Conversation needs an approval");
    expect(sent[0].idempotencyKey).toBe("routine-action:conv_1:approval.request:email:owner%40business.example");
    expect(sent[0].text).toContain("Conversation: conv_1");
    expect(sent[0].text).toContain("Decision: pd_abc");
    // No link resolver is wired here, so the mail omits the line rather than printing a
    // path that does not resolve. See the permalink cases below.
    expect(sent[0].text).not.toContain("Open:");
  });

  it("preserves approval webhook delivery", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      {
        resolve: async () => ({
          emails: [],
          webhook: { url: "https://hooks.example.com/approval" },
        }),
      },
      undefined,
      httpClient,
    );

    await sink.deliver(notification, context);

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://hooks.example.com/approval");
    expect(requests[0].headers["Idempotency-Key"]).toBe("routine-action:conv_1:approval.request:webhook");
    expect(JSON.parse(requests[0].rawBody)).toEqual({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      handle: "pd_abc",
      dashboardUrl: null,
      dashboardPath: null,
      requestId: "request_1",
    });
  });

  it("sends the webhook the resolved permalink, absolute and as a routable path", async () => {
    const { mailer } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: [], webhook: { url: "https://hooks.example.com/approval" } }) },
      undefined,
      httpClient,
      { resolve: async () => "https://app.radioso.ai/w/support-abc/activity?tab=all&filter=chat&itemKind=chat&itemId=conv_1" },
    );

    await sink.deliver(notification, context);

    expect(JSON.parse(requests[0].rawBody)).toMatchObject({
      dashboardUrl: "https://app.radioso.ai/w/support-abc/activity?tab=all&filter=chat&itemKind=chat&itemId=conv_1",
      // Deprecated in favour of `dashboardUrl`; kept for one release so consumers that prefix
      // their own origin keep working, now with a path the dashboard actually routes.
      dashboardPath: "/w/support-abc/activity?tab=all&filter=chat&itemKind=chat&itemId=conv_1",
    });
  });

  it("sends the webhook null links rather than a path that does not route when the workspace cannot be resolved", async () => {
    const { mailer } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: [], webhook: { url: "https://hooks.example.com/approval" } }) },
      undefined,
      httpClient,
      { resolve: async () => null },
    );

    await sink.deliver(notification, context);

    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].rawBody)).toMatchObject({ dashboardUrl: null, dashboardPath: null });
  });

  it("preserves handoff email delivery", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await sink.deliver(handoffNotification, {
      ...context,
      idempotencyKey: "routine-action:conv_1:handoff.notify",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@business.example");
    expect(sent[0].subject).toBe("Conversation needs a human");
    expect(sent[0].idempotencyKey).toBe("routine-action:conv_1:handoff.notify:email:owner%40business.example");
    // Plain prose for non-technical staff: just the headline, nothing technical underneath.
    expect(sent[0].text).toBe("A conversation needs a human operator.\n");
    // No link resolver is wired here, so the mail omits the line rather than printing a
    // path that does not resolve. See the permalink cases below.
    expect(sent[0].text).not.toContain("Open:");
  });

  it("preserves handoff webhook delivery", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      {
        resolve: async () => ({
          emails: [],
          webhook: { url: "https://hooks.example.com/handoff" },
        }),
      },
      undefined,
      httpClient,
    );

    await sink.deliver(handoffNotification, {
      ...context,
      idempotencyKey: "routine-action:conv_1:handoff.notify",
    });

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://hooks.example.com/handoff");
    expect(requests[0].headers["Idempotency-Key"]).toBe("routine-action:conv_1:handoff.notify:webhook");
    expect(JSON.parse(requests[0].rawBody)).toEqual({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      reason: "routine_handoff",
      routine: null,
      collected: {},
      subject: null,
      intro: null,
      dashboardUrl: null,
      dashboardPath: null,
      requestId: "request_1",
    });
  });

  it("names the routine and lists the collected values in the handoff email", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: ["desk@business.example"], webhook: null }) },
      undefined,
      undefined,
      { resolve: async () => "https://app.radioso.ai/w/support-abc/activity?itemId=conv_1" },
    );

    await sink.deliver({
      ...handoffNotification,
      agentName: "Retreat desk",
      routine: { id: "routine_1", name: "Book accommodation" },
      collected: { program: "Yoga retreat", arrival_date: "2026-10-12", guests: 2 },
    }, { ...context, idempotencyKey: "routine-action:conv_1:handoff.notify" });

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Book accommodation: needs a human");
    expect(sent[0].text).toBe([
      "A conversation needs a human operator.",
      "",
      "Collected:",
      "  Program: Yoga retreat",
      "  Arrival date: 2026-10-12",
      "  Guests: 2",
      "",
      "Open: https://app.radioso.ai/w/support-abc/activity?itemId=conv_1",
    ].join("\n"));
  });

  it("matches the Test Chat hand-off preview for the same hand-off, minus the delivered link line", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: ["desk@business.example"], webhook: null }) },
      undefined,
      undefined,
      { resolve: async () => "https://app.radioso.ai/w/support-abc/activity?itemId=conv_1" },
    );

    // The identical construction `WorkbenchReplayRunner.handoffPreviewFor` uses for a
    // Test Chat turn's preview: build the action a routine's handoff terminal would
    // emit, then run its payload through the same shared parser and text formatter the
    // real dispatch handler below also runs — so the two cannot drift from each other.
    const action = buildHandoffNotifyAction({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      userMessageId: "message_1",
      reason: "routine_handoff",
      routineId: "routine_1",
      stepId: "handoff",
      collected: { program: "Yoga retreat", arrival_date: "2026-10-12", guests: 2 },
    });
    const notification = routineEndingNotificationFromAction({
      kind: "handoff",
      payload: action.payload,
      ids: { conversationId: "conv_1", workspaceId: "ws_1" },
      fallback: { reason: "routine_handoff" },
      subject: { agentName: "Retreat desk", routineName: "Book accommodation" },
    });
    const preview = formatRoutineEndingNotification(notification);

    await sink.deliver(notification, { ...context, idempotencyKey: "routine-action:conv_1:handoff.notify" });

    expect(sent).toHaveLength(1);
    // The preview is the message content only: the sink's delivered text is exactly
    // that content plus one line the preview never has — the conversation link a
    // replayed turn has no durable conversation to point to.
    expect(sent[0].subject).toBe(preview.subject);
    expect(sent[0].text).toBe([
      ...preview.lines,
      "Open: https://app.radioso.ai/w/support-abc/activity?itemId=conv_1",
    ].join("\n"));
  });

  it("posts the routine and collected values on the handoff webhook", async () => {
    const { mailer } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: [], webhook: { url: "https://hooks.example.com/handoff" } }) },
      undefined,
      httpClient,
    );

    await sink.deliver({
      ...handoffNotification,
      routine: { id: "routine_1", name: "Book accommodation" },
      collected: { program: "Yoga retreat", arrival_date: "2026-10-12" },
    }, { ...context, idempotencyKey: "routine-action:conv_1:handoff.notify" });

    expect(JSON.parse(requests[0].rawBody)).toEqual({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      reason: "routine_handoff",
      routine: { id: "routine_1", name: "Book accommodation" },
      collected: { program: "Yoga retreat", arrival_date: "2026-10-12" },
      subject: null,
      intro: null,
      dashboardUrl: null,
      dashboardPath: null,
      requestId: "request_1",
    });
  });

  const completionNotification = {
    ...handoffNotification,
    kind: "completion" as const,
    reason: "routine_completed",
    agentName: "Retreat desk",
    routine: { id: "routine_1", name: "Book accommodation" },
    collected: { name: "Ada Lovelace", arrival_date: "2026-10-12" },
    notice: { subject: "New booking: {{slot.name}}", intro: "Confirm {{slot.arrival_date}} with the guest." },
    conversation: { entryPageUrl: "https://ananda.example/stays" },
  };

  it("emails a completion notice in plain text with the authored subject and intro and every collected value", async () => {
    const { mailer, sent } = recordingMailer();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: ["reception@ananda.example"], webhook: null }) },
      undefined,
      undefined,
      { resolve: async () => "https://app.radioso.ai/w/support-abc/activity?itemId=conv_1" },
    );

    await sink.deliver(completionNotification, { ...context, idempotencyKey: "routine-action:conv_1:completion.notify" });

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("New booking: Ada Lovelace");
    expect(sent[0].idempotencyKey).toBe("routine-action:conv_1:completion.notify:email:reception%40ananda.example");
    expect(sent[0].text).toBe([
      "A visitor completed a request in chat.",
      "Confirm 2026-10-12 with the guest.",
      "",
      "Collected:",
      "  Name: Ada Lovelace",
      "  Arrival date: 2026-10-12",
      "",
      "Entry page: https://ananda.example/stays",
      "Open: https://app.radioso.ai/w/support-abc/activity?itemId=conv_1",
    ].join("\n"));
  });

  it("posts a completion notice to the webhook with reason routine_completed and the rendered subject and intro", async () => {
    const { mailer } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: [], webhook: { url: "https://hooks.example.com/notices" } }) },
      undefined,
      httpClient,
    );

    await sink.deliver(completionNotification, { ...context, idempotencyKey: "routine-action:conv_1:completion.notify" });

    expect(requests[0].headers["Idempotency-Key"]).toBe("routine-action:conv_1:completion.notify:webhook");
    expect(JSON.parse(requests[0].rawBody)).toEqual({
      conversationId: "conv_1",
      workspaceId: "ws_1",
      agentId: "agent_1",
      reason: "routine_completed",
      routine: { id: "routine_1", name: "Book accommodation" },
      collected: { name: "Ada Lovelace", arrival_date: "2026-10-12" },
      subject: "New booking: Ada Lovelace",
      intro: "Confirm 2026-10-12 with the guest.",
      dashboardUrl: null,
      dashboardPath: null,
      requestId: "request_1",
    });
  });

  it("no-ops when no recipient is configured", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const warn = vi.fn();
    const sink = new EmailWebhookOperatorNotificationSink(
      mailer,
      { resolve: async () => ({ emails: [], webhook: null }) },
      { warn },
      httpClient,
    );

    await sink.deliver(notification, context);

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});
