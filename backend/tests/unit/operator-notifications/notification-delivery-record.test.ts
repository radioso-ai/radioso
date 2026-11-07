import { describe, expect, it } from "vitest";

import { ContactSendActionHandler } from "../../../src/modules/chat/services/actions/contactSendActionHandler.js";
import type {
  ContactNotificationMailer,
  ContactWebhookHttpClient,
  RoutedContactDeliveryTarget,
} from "../../../src/modules/chat/services/actions/contactSendActionHandler.js";
import { EmailWebhookOperatorNotificationSink } from "../../../src/modules/chat/services/actions/emailWebhookSink.js";
import type {
  NotificationDeliveryAdmissionPort,
  NotificationDeliveryRecorderPort,
  NotificationRecipientPolicyPort,
  RecipientDelivery,
} from "../../../src/modules/operatorNotifications/public.js";

type RecipientState = "confirmed" | "unconfirmed" | "revoked" | "suppressed";

/** The recipient policy as the workspace's confirmation state decides it, with no store behind it. */
const policyFor = (states: Record<string, RecipientState>): Pick<NotificationRecipientPolicyPort, "prepareDelivery"> => ({
  prepareDelivery: async ({ emails }) => {
    const eligibleRecipients = emails.filter((email) => states[email] === "confirmed")
      .map((email) => ({ email, listUnsubscribeUrl: "" }));
    return {
      eligibleEmails: eligibleRecipients.map(({ email }) => email),
      eligibleRecipients,
      skippedRecipients: emails.flatMap((email) => {
        const state = states[email];
        return state === "confirmed" ? [] : [{ email, reason: state }];
      }),
    };
  },
});

const admit = (overrides: Partial<Awaited<ReturnType<NotificationDeliveryAdmissionPort["admit"]>>> = {}): NotificationDeliveryAdmissionPort => ({
  admit: async () => ({ dispatchAllowed: true, emailAllowed: true, reason: null, ...overrides }),
});

interface Harness {
  sent: string[];
  webhookPosts: number;
  records: Array<{ subject: Parameters<NotificationDeliveryRecorderPort["record"]>[0]; deliveries: RecipientDelivery[] }>;
}

interface Scenario {
  emails: string[];
  states?: Record<string, RecipientState>;
  webhook?: boolean;
  admission?: NotificationDeliveryAdmissionPort;
  /** Addresses whose mail the transport rejects. */
  rejecting?: string[];
  /** A transport that records the mail instead of sending it. */
  undispatched?: boolean;
  recorder?: NotificationDeliveryRecorderPort;
}

type SettledOutcome =
  | { settled: "dispatched" }
  | { settled: "partial"; reason: string }
  | { settled: "skipped"; reason: string };

const context = {
  requestId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-0000000000aa",
  accountId: null,
  conversationId: "00000000-0000-4000-8000-0000000000bb",
  idempotencyKey: "key-1",
  attempt: 1,
  skillName: null,
};

const harness = (scenario: Scenario) => {
  const state: Harness = { sent: [], webhookPosts: 0, records: [] };
  const mailer: ContactNotificationMailer = {
    send: async (message) => {
      if (scenario.rejecting?.includes(message.to)) throw new Error("provider rejected the message");
      state.sent.push(message.to);
      return scenario.undispatched ? { dispatched: false, driver: "log" } : { dispatched: true };
    },
  };
  const httpClient: ContactWebhookHttpClient = { post: async () => { state.webhookPosts += 1; } };
  const recorder: NotificationDeliveryRecorderPort = scenario.recorder ?? {
    record: async (subject, deliveries) => { state.records.push({ subject, deliveries: [...deliveries] }); },
  };
  const target: RoutedContactDeliveryTarget = {
    emails: scenario.emails,
    webhook: scenario.webhook ? { url: "https://hooks.example.com/notice" } : null,
    via: "agent_setting",
    recipientsFromWorkspaceOwner: false,
  };
  const states = scenario.states ?? Object.fromEntries(scenario.emails.map((email) => [email, "confirmed" as const]));
  return { state, mailer, httpClient, recorder, target, policy: policyFor(states), admission: scenario.admission ?? admit() };
};

const settle = async (run: () => Promise<{ disposition: string; reason?: string } | void>): Promise<SettledOutcome> => {
  try {
    const outcome = await run();
    if (outcome && outcome.disposition === "partial") return { settled: "partial", reason: outcome.reason! };
    return { settled: "dispatched" };
  } catch (error) {
    if (error instanceof Error && error.name === "ActionDispatchSkippedError") {
      return { settled: "skipped", reason: (error as Error & { reason: string }).reason };
    }
    throw error;
  }
};

/** The two senders of notices behave the same: each runs the same scenarios through the same plan and record. */
const senders: Array<{
  name: string;
  run: (scenario: Scenario) => Promise<{ outcome: SettledOutcome; state: Harness }>;
}> = [
  {
    name: "contact.send",
    run: async (scenario) => {
      const { state, mailer, httpClient, recorder, target, policy, admission } = harness(scenario);
      const handler = new ContactSendActionHandler(
        mailer,
        { resolve: async () => target },
        undefined,
        httpClient,
        undefined,
        admission,
        policy,
        recorder,
      );
      const outcome = await settle(() => handler.handle({ payload: { message: "Please call me" }, context }));
      return { outcome, state };
    },
  },
  {
    name: "operator notice",
    run: async (scenario) => {
      const { state, mailer, httpClient, recorder, target, policy, admission } = harness(scenario);
      const sink = new EmailWebhookOperatorNotificationSink(
        mailer,
        { resolve: async () => target },
        undefined,
        httpClient,
        undefined,
        admission,
        policy,
        recorder,
      );
      const outcome = await settle(async () => {
        const result = await sink.deliver({
          kind: "handoff",
          workspaceId: context.workspaceId,
          conversationId: context.conversationId,
          agentId: "00000000-0000-4000-8000-0000000000cc",
          reason: "customer_requested_human",
        }, context);
        if (result.disposition === "skipped") {
          const error = Object.assign(new Error(result.reason), { reason: result.reason });
          error.name = "ActionDispatchSkippedError";
          throw error;
        }
        return result.disposition === "partial" ? result : { disposition: "dispatched" };
      });
      return { outcome, state };
    },
  },
];

describe.each(senders)("per-recipient delivery record: $name", ({ run }) => {
  it("records every address as sent and settles dispatched when all of them went out", async () => {
    const { outcome, state } = await run({ emails: ["one@example.com", "two@example.com"] });

    expect(outcome).toEqual({ settled: "dispatched" });
    expect(state.sent).toEqual(["one@example.com", "two@example.com"]);
    expect(state.records).toHaveLength(1);
    expect(state.records[0].subject).toMatchObject({
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      requestId: context.requestId,
    });
    expect(state.records[0].deliveries).toEqual([
      { email: "one@example.com", outcome: "sent" },
      { email: "two@example.com", outcome: "sent" },
    ]);
  });

  it("settles a send that skipped an unconfirmed address as partial and records why for each address", async () => {
    const { outcome, state } = await run({
      emails: ["ready@example.com", "waiting@example.com"],
      states: { "ready@example.com": "confirmed", "waiting@example.com": "unconfirmed" },
    });

    expect(outcome).toEqual({ settled: "partial", reason: "notification_recipient_unconfirmed" });
    expect(state.sent).toEqual(["ready@example.com"]);
    expect(state.records[0].deliveries).toEqual(expect.arrayContaining([
      { email: "ready@example.com", outcome: "sent" },
      { email: "waiting@example.com", outcome: "skipped_unconfirmed" },
    ]));
  });

  it("names a stopped and a bounced address by their own reason", async () => {
    const { outcome, state } = await run({
      emails: ["ready@example.com", "stopped@example.com", "bounced@example.com"],
      states: { "ready@example.com": "confirmed", "stopped@example.com": "revoked", "bounced@example.com": "suppressed" },
    });

    expect(outcome).toEqual({ settled: "partial", reason: "notification_recipient_revoked" });
    expect(state.records[0].deliveries).toEqual(expect.arrayContaining([
      { email: "stopped@example.com", outcome: "skipped_revoked" },
      { email: "bounced@example.com", outcome: "skipped_suppressed" },
    ]));
  });

  it("settles skipped, not partial, when no address is eligible and there is no webhook", async () => {
    const { outcome, state } = await run({
      emails: ["waiting@example.com"],
      states: { "waiting@example.com": "unconfirmed" },
    });

    expect(outcome).toEqual({ settled: "skipped", reason: "notification_recipient_unconfirmed" });
    expect(state.sent).toEqual([]);
    expect(state.records[0].deliveries).toEqual([{ email: "waiting@example.com", outcome: "skipped_unconfirmed" }]);
  });

  it("settles partial when the webhook went out and the only address was skipped", async () => {
    const { outcome, state } = await run({
      emails: ["waiting@example.com"],
      states: { "waiting@example.com": "unconfirmed" },
      webhook: true,
    });

    expect(outcome).toEqual({ settled: "partial", reason: "notification_recipient_unconfirmed" });
    expect(state.webhookPosts).toBe(1);
    expect(state.sent).toEqual([]);
  });

  it("settles dispatched, recording nothing, for a webhook-only destination", async () => {
    const { outcome, state } = await run({ emails: [], webhook: true });

    expect(outcome).toEqual({ settled: "dispatched" });
    expect(state.webhookPosts).toBe(1);
    expect(state.records).toEqual([]);
  });

  it("records the daily email cap against each address that would have been emailed", async () => {
    const { outcome, state } = await run({
      emails: ["one@example.com", "waiting@example.com"],
      states: { "one@example.com": "confirmed", "waiting@example.com": "unconfirmed" },
      admission: admit({ emailAllowed: false, reason: "workspace_daily_email_cap" }),
    });

    expect(outcome).toEqual({ settled: "skipped", reason: "workspace_daily_email_cap" });
    expect(state.sent).toEqual([]);
    expect(state.records[0].deliveries).toEqual(expect.arrayContaining([
      { email: "one@example.com", outcome: "skipped_cap" },
      { email: "waiting@example.com", outcome: "skipped_unconfirmed" },
    ]));
  });

  it("records the conversation cap when it stops the whole notice", async () => {
    const { outcome, state } = await run({
      emails: ["one@example.com"],
      webhook: true,
      admission: admit({ dispatchAllowed: false, emailAllowed: false, reason: "conversation_dispatch_cap" }),
    });

    expect(outcome).toEqual({ settled: "skipped", reason: "conversation_dispatch_cap" });
    expect(state.sent).toEqual([]);
    expect(state.webhookPosts).toBe(0);
    expect(state.records[0].deliveries).toEqual([{ email: "one@example.com", outcome: "skipped_cap" }]);
  });

  it("records a transport that sent nothing as not dispatched, and skips the action when no webhook went out", async () => {
    const { outcome, state } = await run({ emails: ["one@example.com"], undispatched: true });

    expect(outcome).toEqual({ settled: "skipped", reason: "mail_not_dispatched:driver=log" });
    expect(state.records[0].deliveries).toEqual([{ email: "one@example.com", outcome: "not_dispatched" }]);
  });

  it("records the addresses that went out and the one that failed before rethrowing so the action retries", async () => {
    const records: Harness["records"] = [];
    await expect(run({
      emails: ["one@example.com", "broken@example.com"],
      rejecting: ["broken@example.com"],
      recorder: { record: async (subject, deliveries) => { records.push({ subject, deliveries: [...deliveries] }); } },
    })).rejects.toThrow("provider rejected the message");

    expect(records).toHaveLength(1);
    expect(records[0].deliveries).toEqual([
      { email: "one@example.com", outcome: "sent" },
      { email: "broken@example.com", outcome: "failed" },
    ]);
  });

  it("leaves delivery intact when the record cannot be written", async () => {
    const { outcome, state } = await run({
      emails: ["one@example.com"],
      webhook: true,
      recorder: { record: async () => { throw new Error("database is down for one@example.com"); } },
    });

    expect(outcome).toEqual({ settled: "dispatched" });
    expect(state.sent).toEqual(["one@example.com"]);
    expect(state.webhookPosts).toBe(1);
  });
});
