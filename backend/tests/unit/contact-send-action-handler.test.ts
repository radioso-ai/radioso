import { describe, expect, it, vi } from "vitest";

import {
  ConfiguredContactDeliveryResolver,
  ContactSendActionHandler,
  FetchContactWebhookHttpClient,
  WorkspaceOwnerContactRecipientResolver,
  type ContactNotificationMailer,
  type ContactWebhookHttpClient,
} from "../../src/modules/chat/services/actions/contactSendActionHandler.js";

const context = {
  requestId: "request_1",
  workspaceId: "ws_1",
  accountId: null,
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:contact.send:hash",
  attempt: 1,
  skillName: null,
};

type SentMessage = Parameters<ContactNotificationMailer["send"]>[0];
type WebhookRequest = Parameters<ContactWebhookHttpClient["post"]>[0];

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

describe("ContactSendActionHandler", () => {
  it("emails the gathered contact request to the resolved recipient, with the visitor email as reply-to", async () => {
    const { mailer, sent } = recordingMailer();
    const handler = new ContactSendActionHandler(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await handler.handle({
      payload: { name: "Alex", email: "alex@example.com", message: "Please call me about pricing." },
      context,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@business.example");
    expect(sent[0]!.replyTo).toBe("alex@example.com");
    expect(sent[0]!.idempotencyKey).toBe("routine-action:conv_1:contact.send:hash:email:owner%40business.example");
    expect(sent[0]!.text).toContain("Alex");
    expect(sent[0]!.text).toContain("alex@example.com");
    expect(sent[0]!.text).toContain("Please call me about pricing.");
  });

  it("fans out email delivery to every resolved recipient with per-address idempotency", async () => {
    const { mailer, sent } = recordingMailer();
    const handler = new ContactSendActionHandler(mailer, {
      resolve: async () => ({ emails: ["owner@business.example", "sales@business.example"], webhook: null }),
    });

    await handler.handle({
      payload: { name: "Alex", email: "alex@example.com", message: "Please call me about pricing." },
      context,
    });

    expect(sent.map((message) => message.to)).toEqual(["owner@business.example", "sales@business.example"]);
    expect(sent.map((message) => message.idempotencyKey)).toEqual([
      "routine-action:conv_1:contact.send:hash:email:owner%40business.example",
      "routine-action:conv_1:contact.send:hash:email:sales%40business.example",
    ]);
  });

  it("posts configured webhooks with conversation metadata and an idempotency key", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const handler = new ContactSendActionHandler(
      mailer,
      {
        resolve: async () => ({
          emails: [],
          webhook: { url: "https://hooks.example.com/contact" },
        }),
      },
      undefined,
      httpClient,
    );

    await handler.handle({
      payload: { name: "Alex", email: "alex@example.com", message: "Please call me about pricing." },
      context,
    });

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://hooks.example.com/contact");
    expect(requests[0]!.headers["Idempotency-Key"]).toBe("routine-action:conv_1:contact.send:hash:webhook");
    expect(JSON.parse(requests[0]!.rawBody)).toEqual({
      name: "Alex",
      email: "alex@example.com",
      message: "Please call me about pricing.",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      requestId: "request_1",
    });
    // Signing was dropped: no signature/timestamp headers are sent.
    expect(requests[0]!.headers["X-Radioso-Signature"]).toBeUndefined();
    expect(requests[0]!.headers["X-Radioso-Timestamp"]).toBeUndefined();
  });

  it("delivers email and webhook together when both are configured", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const handler = new ContactSendActionHandler(
      mailer,
      {
        resolve: async () => ({
          emails: ["owner@business.example"],
          webhook: { url: "https://hooks.example.com/contact" },
        }),
      },
      undefined,
      httpClient,
    );

    await handler.handle({ payload: { email: "alex@example.com", message: "hi" }, context });

    expect(sent).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("no-ops (does not send, does not throw) when no recipient is configured", async () => {
    const { mailer, sent } = recordingMailer();
    const { httpClient, requests } = recordingWebhookClient();
    const warn = vi.fn();
    const handler = new ContactSendActionHandler(
      mailer,
      { resolve: async () => ({ emails: [], webhook: null }) },
      { warn },
      httpClient,
    );

    await handler.handle({ payload: { email: "alex@example.com", message: "hi" }, context });

    expect(sent).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("tolerates missing optional payload fields", async () => {
    const { mailer, sent } = recordingMailer();
    const handler = new ContactSendActionHandler(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await handler.handle({ payload: {}, context });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.replyTo).toBeNull();
  });
});

describe("ContactSendActionHandler.recordFailureOutcome", () => {
  const payloadWithPii = { name: "Alex", email: "alex@example.com", message: "call me about pricing please" };

  it("reports a terminal (failed) outcome to the error reporter and logs a warning, with no PII", async () => {
    const { mailer } = recordingMailer();
    const warn = vi.fn();
    const report = vi.fn().mockResolvedValue(undefined);
    const handler = new ContactSendActionHandler(
      mailer,
      { resolve: async () => ({ emails: ["owner@business.example"], webhook: null }) },
      { warn },
      undefined,
      { report },
    );

    await handler.recordFailureOutcome({
      payload: payloadWithPii,
      context,
      outcome: "failed",
      error: "Resend API returned 500",
    });

    expect(report).toHaveBeenCalledOnce();
    const [reportInput] = report.mock.calls[0]!;
    expect(reportInput.errorType).toBe("action.contact_send.delivery_failed");
    expect(reportInput.severity).toBe("error");
    expect(reportInput.metadata).toMatchObject({
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      requestId: context.requestId,
    });

    expect(warn).toHaveBeenCalledOnce();
    const [warnPayload] = warn.mock.calls[0]!;

    // No visitor content (email/name/message) anywhere in either call.
    const serialized = JSON.stringify([reportInput, warnPayload]);
    expect(serialized).not.toContain("alex@example.com");
    expect(serialized).not.toContain("call me about pricing");
    expect(serialized).not.toContain("Alex");
  });

  it("reports a bounded classification, never the raw caught error text, to the external error reporter", async () => {
    const { mailer } = recordingMailer();
    const report = vi.fn().mockResolvedValue(undefined);
    const handler = new ContactSendActionHandler(
      mailer,
      { resolve: async () => ({ emails: ["owner@business.example"], webhook: null }) },
      undefined,
      undefined,
      { report },
    );

    // A provider or webhook error is caught-and-stringified upstream (see
    // ActionDispatcher) before it reaches recordFailureOutcome, so the handler
    // cannot tell a bounded internal message from one that echoes a response
    // body, a signed webhook URL, or a reply-to address — it must never forward
    // that text verbatim to an external sink.
    const rawProviderError = "Webhook POST failed: https://hooks.example.com/contact?token=SUPER_SECRET_TOKEN (reply-to visitor@example.com)";

    await handler.recordFailureOutcome({
      payload: payloadWithPii,
      context,
      outcome: "failed",
      error: rawProviderError,
    });

    expect(report).toHaveBeenCalledOnce();
    const [reportInput] = report.mock.calls[0]!;

    // Neither a forwarded `error` object nor the `message`/`errorClass` fields may
    // carry the raw text — `new Error(rawProviderError)` would leak it via
    // `.message` (and `.stack`, whose first line embeds the message).
    const errorMessage = reportInput.error instanceof Error ? reportInput.error.message : "";
    const errorStack = reportInput.error instanceof Error ? (reportInput.error.stack ?? "") : "";
    const surfaced = [errorMessage, errorStack, reportInput.message, reportInput.errorClass]
      .filter((value): value is string => typeof value === "string")
      .join("\n");

    expect(surfaced).not.toContain("SUPER_SECRET_TOKEN");
    expect(surfaced).not.toContain("visitor@example.com");
    expect(surfaced).not.toContain("hooks.example.com");

    // Still alertable — a bounded classification is reported, not silence.
    expect(surfaced.trim().length).toBeGreaterThan(0);
  });

  it("does not report a retryable (non-terminal) outcome — retries are expected, not alertable", async () => {
    const { mailer } = recordingMailer();
    const warn = vi.fn();
    const report = vi.fn().mockResolvedValue(undefined);
    const handler = new ContactSendActionHandler(
      mailer,
      { resolve: async () => ({ emails: ["owner@business.example"], webhook: null }) },
      { warn },
      undefined,
      { report },
    );

    await handler.recordFailureOutcome({
      payload: payloadWithPii,
      context,
      outcome: "retry",
      error: "temporary network error",
    });

    expect(report).not.toHaveBeenCalled();
  });

  it("does not throw when no error reporter is configured", async () => {
    const { mailer } = recordingMailer();
    const handler = new ContactSendActionHandler(mailer, {
      resolve: async () => ({ emails: ["owner@business.example"], webhook: null }),
    });

    await expect(handler.recordFailureOutcome({
      payload: payloadWithPii,
      context,
      outcome: "failed",
      error: "boom",
    })).resolves.toBeUndefined();
  });

  it("does not throw when the error reporter itself rejects", async () => {
    const { mailer } = recordingMailer();
    const report = vi.fn().mockRejectedValue(new Error("sink down"));
    const handler = new ContactSendActionHandler(
      mailer,
      { resolve: async () => ({ emails: ["owner@business.example"], webhook: null }) },
      undefined,
      undefined,
      { report },
    );

    await expect(handler.recordFailureOutcome({
      payload: payloadWithPii,
      context,
      outcome: "failed",
      error: "boom",
    })).resolves.toBeUndefined();
  });
});

describe("FetchContactWebhookHttpClient", () => {
  const okResponse = () => new Response(null, { status: 204 });
  const redirect = (location: string) => new Response(null, { status: 307, headers: { location } });

  it("rejects (does not fetch) a URL the SSRF guard blocks", async () => {
    const fetchSpy = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchSpy);
    const guard = vi.fn(async (url: string) => {
      if (url.includes("169.254.169.254") || url.includes("127.0.0.1")) {
        throw new Error("Website URL must resolve to a publicly routable host");
      }
    });
    const client = new FetchContactWebhookHttpClient(guard);

    await expect(
      client.post({ url: "http://169.254.169.254/latest/meta-data", rawBody: "{}", headers: {} }),
    ).rejects.toThrow("publicly routable");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("re-validates every redirect hop against the guard before following", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(redirect("http://127.0.0.1/internal"))
      .mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchSpy);
    const guard = vi.fn(async (url: string) => {
      if (url.includes("127.0.0.1")) {
        throw new Error("Website URL must resolve to a publicly routable host");
      }
    });
    const client = new FetchContactWebhookHttpClient(guard);

    // A public URL that 3xx-redirects to a private host must be blocked at the hop,
    // never delivered. fetch ran once (the public hop); the redirect target is refused.
    await expect(
      client.post({ url: "https://hooks.example.com/contact", rawBody: "{}", headers: {} }),
    ).rejects.toThrow("publicly routable");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(guard).toHaveBeenNthCalledWith(2, "http://127.0.0.1/internal");
    vi.unstubAllGlobals();
  });

  it("sends with redirect:manual and a bounded timeout signal", async () => {
    let observed: RequestInit | undefined;
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      observed = init;
      return okResponse();
    });
    vi.stubGlobal("fetch", fetchSpy);
    const client = new FetchContactWebhookHttpClient(async () => {}, { timeoutMs: 5_000 });

    await client.post({ url: "https://hooks.example.com/contact", rawBody: "{\"a\":1}", headers: { "X-A": "1" } });

    expect(observed?.method).toBe("POST");
    expect(observed?.redirect).toBe("manual");
    expect(observed?.body).toBe("{\"a\":1}");
    expect(observed?.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  it("propagates a timed-out/aborted fetch so the action is retried", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const client = new FetchContactWebhookHttpClient(async () => {});

    await expect(
      client.post({ url: "https://hooks.example.com/contact", rawBody: "{}", headers: {} }),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("WorkspaceOwnerContactRecipientResolver", () => {
  const resolver = (members: { role: string; email: string }[]) =>
    new WorkspaceOwnerContactRecipientResolver(
      { findById: async () => ({ accountId: "acc_1" }) },
      { listActiveByAccount: async () => members },
    );

  it("resolves the workspace owner's email", async () => {
    const result = await resolver([
      { role: "member", email: "m@x.com" },
      { role: "owner", email: "owner@x.com" },
    ]).resolve({ ...context, workspaceId: "ws_1", conversationId: "c" });
    expect(result).toEqual({ emails: ["owner@x.com"], webhook: null });
  });

  it("falls back to an admin when there is no owner", async () => {
    const result = await resolver([
      { role: "member", email: "m@x.com" },
      { role: "admin", email: "admin@x.com" },
    ]).resolve({ ...context, workspaceId: "ws_1", conversationId: "c" });
    expect(result).toEqual({ emails: ["admin@x.com"], webhook: null });
  });

  it("returns null when no workspaceId, no workspace, or no owner/admin", async () => {
    expect(
      await resolver([]).resolve({ ...context, workspaceId: null, conversationId: "c" }),
    ).toEqual({ emails: [], webhook: null });
    expect(
      await new WorkspaceOwnerContactRecipientResolver(
        { findById: async () => null },
        { listActiveByAccount: async () => [] },
      ).resolve({ ...context, workspaceId: "ws_1", conversationId: "c" }),
    ).toEqual({ emails: [], webhook: null });
    expect(
      await resolver([{ role: "member", email: "m@x.com" }]).resolve({
        ...context,
        workspaceId: "ws_1",
        conversationId: "c",
      }),
    ).toEqual({ emails: [], webhook: null });
  });
});

describe("ConfiguredContactDeliveryResolver", () => {
  it("uses configured agent recipient emails and passes through webhook settings", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: {
            recipientEmails: ["sales@example.com"],
            webhook: { url: "https://hooks.example.com/contact" },
          },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
    );

    await expect(resolver.resolve(context)).resolves.toEqual({
      emails: ["sales@example.com"],
      webhook: { url: "https://hooks.example.com/contact" },
    });
  });

  it("falls back to workspace owner delivery when no recipient emails are configured", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: {
            recipientEmails: [],
            webhook: null,
          },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
    );

    await expect(resolver.resolve(context)).resolves.toEqual({
      emails: ["owner@example.com"],
      webhook: null,
    });
  });

  it("prefers the contact_human notify skill delivery over legacy agent delivery", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: {
            recipientEmails: ["legacy@example.com"],
            webhook: null,
          },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
      {
        findByName: async () => ({
          kind: "notify",
          enabled: true,
          config: {
            delivery: {
              recipientEmails: ["sales@example.com"],
              webhook: { url: "https://hooks.example.com/contact" },
            },
          },
        }),
      },
    );

    await expect(resolver.resolve(context)).resolves.toEqual({
      emails: ["sales@example.com"],
      webhook: { url: "https://hooks.example.com/contact" },
    });
  });

  it("treats a disabled contact_human notify skill as no delivery target", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: {
            recipientEmails: ["legacy@example.com"],
            webhook: null,
          },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
      {
        findByName: async () => ({
          kind: "notify",
          enabled: false,
          config: {
            delivery: { recipientEmails: ["sales@example.com"], webhook: null },
          },
        }),
      },
    );

    await expect(resolver.resolve(context)).resolves.toEqual({ emails: [], webhook: null });
  });

  it("prefers the outbox row's named skill delivery over both the hardcoded contact_human skill and legacy agent delivery", async () => {
    const findByName = vi.fn(async (_ws: string, _agentId: string, skillName: string) => {
      if (skillName === "contact_sales") {
        return {
          kind: "notify",
          enabled: true,
          config: {
            delivery: {
              recipientEmails: ["sales@example.com"],
              webhook: { url: "https://hooks.example.com/sales" },
            },
          },
        };
      }
      // A distinct contact_human skill also exists and is enabled — the named
      // skill on the outbox row must still win.
      return {
        kind: "notify",
        enabled: true,
        config: { delivery: { recipientEmails: ["generic@example.com"], webhook: null } },
      };
    });
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: { recipientEmails: ["legacy@example.com"], webhook: null },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
      { findByName },
    );

    await expect(resolver.resolve({ ...context, skillName: "contact_sales" })).resolves.toEqual({
      emails: ["sales@example.com"],
      webhook: { url: "https://hooks.example.com/sales" },
    });
  });

  it("falls back to the owner's email when the named skill's webhook is configured but recipients are empty", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: { recipientEmails: ["legacy@example.com"], webhook: null },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
      {
        findByName: async (_ws, _agentId, skillName) =>
          skillName === "contact_sales"
            ? {
                kind: "notify",
                enabled: true,
                config: { delivery: { recipientEmails: [], webhook: { url: "https://hooks.example.com/sales" } } },
              }
            : null,
      },
    );

    await expect(resolver.resolve({ ...context, skillName: "contact_sales" })).resolves.toEqual({
      emails: ["owner@example.com"],
      webhook: { url: "https://hooks.example.com/sales" },
    });
  });

  it("falls back to today's behaviour (not black-holing) when the named skill is disabled", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: { recipientEmails: ["legacy@example.com"], webhook: null },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
      {
        // The named skill exists but is disabled; there is no separate contact_human
        // skill configured for this agent (findByName returns null for it).
        findByName: async (_ws, _agentId, skillName) =>
          skillName === "contact_sales"
            ? {
                kind: "notify",
                enabled: false,
                config: { delivery: { recipientEmails: ["sales@example.com"], webhook: null } },
              }
            : null,
      },
    );

    // Unlike the hardcoded contact_human branch (which short-circuits to no
    // recipient), a disabled *named* skill must not black-hole the request — it
    // falls through to the legacy agent-level delivery below.
    await expect(resolver.resolve({ ...context, skillName: "contact_sales" })).resolves.toEqual({
      emails: ["legacy@example.com"],
      webhook: null,
    });
  });

  it("falls back to today's behaviour (not black-holing) when the named skill no longer exists", async () => {
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      {
        findByIdAndWorkspaceId: async () => ({
          contactRequestDelivery: { recipientEmails: ["legacy@example.com"], webhook: null },
        }),
      },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
      // The skill named on the row was deleted or renamed — every lookup misses.
      { findByName: async () => null },
    );

    await expect(resolver.resolve({ ...context, skillName: "renamed_or_deleted_skill" })).resolves.toEqual({
      emails: ["legacy@example.com"],
      webhook: null,
    });
  });

  it("behaves exactly as today when the row names no skill, even when other named notify skills exist", async () => {
    const findByName = vi.fn(async (_ws: string, _agentId: string, skillName: string) =>
      skillName === "contact_human"
        ? { kind: "notify", enabled: true, config: { delivery: { recipientEmails: ["generic@example.com"], webhook: null } } }
        : { kind: "notify", enabled: true, config: { delivery: { recipientEmails: ["sales@example.com"], webhook: null } } },
    );
    const resolver = new ConfiguredContactDeliveryResolver(
      { findByIdAndWorkspaceId: async () => ({ agentId: "agent_1" }) },
      { findByIdAndWorkspaceId: async () => ({ contactRequestDelivery: { recipientEmails: [], webhook: null } }) },
      { resolve: async () => ({ emails: ["owner@example.com"], webhook: null }) },
      { findByName },
    );

    await expect(resolver.resolve({ ...context, skillName: null })).resolves.toEqual({
      emails: ["generic@example.com"],
      webhook: null,
    });
    // The named-skill branch never runs without a skill name on the row — only the
    // hardcoded contact_human lookup fires, same as before this change.
    expect(findByName).toHaveBeenCalledOnce();
    expect(findByName).toHaveBeenCalledWith(context.workspaceId, "agent_1", "contact_human");
  });
});
