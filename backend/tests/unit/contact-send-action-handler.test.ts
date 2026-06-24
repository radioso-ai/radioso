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
});
