import { describe, expect, it, vi } from "vitest";

import { EmailChannelCopilotView } from "../../../src/modules/emailChannel/public.js";
import { filterCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { operatorMcpToolSchemas } from "../../../src/modules/operatorCopilot/mcpToolSchema.js";
import { createEmailChannelCopilotTools, type CopilotEmailChannelPort } from "../../../src/modules/operatorCopilot/tools/emailChannel.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes } from "../../support/inMemoryEmailChannel.js";

const NOW = new Date("2026-10-03T12:00:00.000Z");
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const RELAY_TOKEN = "QZ2K7XN4VTM3RLHJWPC6YGBSFD";
const THREAD_TOKEN = "threadtoken123";

const context = {
  workspaceId: WORKSPACE_ID,
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

/** The real token-free view over in-memory tables seeded with every secret a mailbox has. */
const copilotView = () => {
  const domains = new InMemoryEmailDomains(() => NOW);
  const mailboxes = new InMemoryEmailMailboxes(() => NOW);
  const domain = domains.seed({
    workspaceId: WORKSPACE_ID,
    domain: "customer.test",
    sendingStatus: "verified",
    dnsRecords: [{ purpose: "dkim", type: "TXT", name: "resend._domainkey.customer.test", value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC", status: "verified" }],
  });
  const mailbox = mailboxes.seed({
    workspaceId: WORKSPACE_ID,
    domainId: domain.id,
    address: "support@customer.test",
    relayToken: RELAY_TOKEN,
    previousRelayToken: "PREVIOUSRELAYTOKENPREVIOUS",
    setupCheckStep: "plus_address",
    setupCheckStartedAt: NOW,
    lastReceivedAt: new Date("2026-10-03T11:00:00.000Z"),
  });
  const events = {
    summarize: vi.fn(async (_workspaceId: string, mailboxId: string, windowHours: number) => ({
      mailboxId,
      window: `${windowHours}h`,
      byDisposition: { ingest_only: 4, drop: 1 },
      failed: 1,
      lastReceivedAt: "2026-10-03T11:00:00.000Z",
    })),
  };
  const facts = {
    read: vi.fn(async (_workspaceId: string, conversationId: string) => conversationId !== CONVERSATION_ID ? null : {
      mailbox: { id: mailbox.id, address: mailbox.address, displayName: "Support", engagementMode: "operator_only" as const },
      participant: { address: "alice@example.test", displayName: "Alice Example" },
      latest: { subject: "Question about my order", cc: ["bob@example.test"], inboundAt: "2026-10-03T11:00:00.000Z" },
      sending: { state: "ok" as const },
      sendBudget: { used: 0, limit: 3, renewedAt: null },
      messages: [{
        messageId: "33333333-3333-4333-8333-333333333333",
        direction: "inbound" as const,
        subject: "Question about my order",
        cc: ["bob@example.test"],
        attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 1024 }],
        delivery: null,
        rawDeliveryId: "44444444-4444-4444-8444-444444444444",
      }],
    }),
  };
  const view = new EmailChannelCopilotView({ mailboxes, domains, events, facts, supportedModes: ["operator_only"], clock: () => NOW });
  return { view, mailbox, events, facts };
};

const HELD_REPLY_ID = "66666666-6666-4666-8666-666666666666";

/** A held reply as handoff's operator view presents it, with the rows' internals a careless projection would pass on. */
const heldReplyView = (overrides: Record<string, unknown> = {}) => ({
  id: HELD_REPLY_ID,
  conversationId: CONVERSATION_ID,
  agentId: "77777777-7777-4777-8777-777777777777",
  state: "pending" as const,
  holdReason: "draft_mode",
  facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: true, reason: "refund_over_limit" } } as const,
  dependsOnSuppressedAction: true,
  suppressedEffects: [{ skillName: "issue_refund" }],
  draftText: "Your refund was issued on Monday.",
  editedText: null,
  answersMessageId: "33333333-3333-4333-8333-333333333333",
  releasedMessageId: null,
  createdAt: new Date("2026-10-03T11:30:00.000Z"),
  decidedAt: null,
  releaserUserId: "operator-2",
  editorUserId: null,
  discardedByUserId: null,
  supersededReason: null,
  attentionOpen: true,
  presentation: { metadata: { citations: [{ documentId: "doc-1" }], turnTrace: { spine: [] } } },
  policy: { ref: "email_mailbox:mailbox-1", version: 5 },
  reviewRef: "email:review:1",
  workspaceId: WORKSPACE_ID,
  ...overrides,
});

const heldRepliesPort = (page: Array<ReturnType<typeof heldReplyView>> = [heldReplyView()]) => ({
  list: vi.fn(async () => ({ items: page, nextCursor: "next-page" })),
  current: vi.fn(async (_actor: unknown, conversationId: string) => ({
    heldReply: conversationId === CONVERSATION_ID ? heldReplyView() : null,
  })),
});

/** The held reply as Ray reads it: the operator view's fields, chosen one by one. */
const heldReplyProjection = {
  id: HELD_REPLY_ID,
  conversationId: CONVERSATION_ID,
  agentId: "77777777-7777-4777-8777-777777777777",
  state: "pending",
  holdReason: "draft_mode",
  facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: true, reason: "refund_over_limit" } },
  dependsOnSuppressedAction: true,
  suppressedEffects: [{ skillName: "issue_refund" }],
  draftText: "Your refund was issued on Monday.",
  editedText: null,
  answersMessageId: "33333333-3333-4333-8333-333333333333",
  releasedMessageId: null,
  supersededReason: null,
  createdAt: "2026-10-03T11:30:00.000Z",
  decidedAt: null,
  attentionOpen: true,
};

const toolsOver = (
  emailChannel: ReturnType<typeof copilotView>["view"] | null,
  /** Null where no held replies are composed into Ray. */
  heldReplies: ReturnType<typeof heldRepliesPort> | null = heldRepliesPort(),
) => {
  const descriptors = createEmailChannelCopilotTools({ emailChannel, ...(heldReplies ? { heldReplies } : {}) });
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const invoke = async (name: string, input: unknown) => {
    const descriptor = byName.get(name);
    if (!descriptor) throw new Error(`No ${name} tool`);
    const parsed = descriptor.inputSchema.parse(input);
    const output = await descriptor.createTool(context).invoke(parsed, {} as never);
    return descriptor.outputSchema.parse(output) as Record<string, unknown>;
  };
  return { descriptors, byName, invoke };
};

const SECRETS = [RELAY_TOKEN.toLowerCase(), RELAY_TOKEN, "PREVIOUSRELAYTOKENPREVIOUS", THREAD_TOKEN, "alice@example.test", "bob@example.test", "+check", "p=MIGf", "@in.relay"];
const leaked = (output: unknown): string[] => SECRETS.filter((secret) => JSON.stringify(output).includes(secret));

describe("email channel Ray tools", () => {
  it("declares four read tools with the permissions of the operations they mirror", () => {
    const { descriptors } = toolsOver(copilotView().view);

    expect(descriptors.map(({ name, shape, requiredPermissions }) => ({ name, shape, requiredPermissions }))).toEqual([
      { name: "email_channel_configuration", shape: "read", requiredPermissions: ["workspace.settings.read"] },
      { name: "email_channel_events", shape: "read", requiredPermissions: ["workspace.settings.read"] },
      { name: "email_conversation_facts", shape: "read", requiredPermissions: ["workspace.conversation.takeover"] },
      { name: "held_replies", shape: "read", requiredPermissions: ["workspace.conversation.takeover"] },
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.verificationCost({})).toBe(0);
      expect(descriptor.createTool(context).description).toBe(descriptor.description);
    }
  });

  it("is listed only to an operator holding each tool's permission", () => {
    const { descriptors } = toolsOver(copilotView().view);

    expect(filterCopilotToolCatalog(descriptors, new Set(["workspace.settings.read"])).map(({ name }) => name))
      .toEqual(["email_channel_configuration", "email_channel_events"]);
    expect(filterCopilotToolCatalog(descriptors, new Set(["workspace.conversation.takeover"])).map(({ name }) => name))
      .toEqual(["email_conversation_facts", "held_replies"]);
    expect(filterCopilotToolCatalog(descriptors, new Set())).toEqual([]);
  });

  it("advertises object-rooted input and output schemas an MCP client can read", () => {
    for (const descriptor of toolsOver(copilotView().view).descriptors) {
      const { inputSchema, outputSchema } = operatorMcpToolSchemas(descriptor);
      expect(inputSchema.type).toBe("object");
      expect(outputSchema.type).toBe("object");
      expect(JSON.stringify(outputSchema)).not.toContain("\"exclusiveMinimum\":true");
    }
  });

  it("reads the configuration through the token-free view, with no relay address or setup-check recipient", async () => {
    const { view, mailbox } = copilotView();

    const output = await toolsOver(view).invoke("email_channel_configuration", {});

    expect(output).toEqual({
      configured: true,
      supportedModes: ["operator_only"],
      defaultMode: "operator_only",
      domains: [expect.objectContaining({
        domain: "customer.test",
        sendingStatus: "verified",
        receivingStatus: "not_requested",
        records: [{ purpose: "dkim", type: "TXT", name: "resend._domainkey.customer.test", status: "verified" }],
      })],
      mailboxes: [{
        id: mailbox.id,
        address: "support@customer.test",
        agentId: null,
        engagementMode: "operator_only",
        enabled: true,
        receivingState: "ok",
        lastReceivedAt: "2026-10-03T11:00:00.000Z",
        sendingState: "ok",
        threadSendBudget: 3,
        hourlyGenerationBudget: 30,
      }],
    });
    expect(leaked(output)).toEqual([]);
    expect(JSON.stringify(output)).not.toContain("relayAddress");
    expect(JSON.stringify(output)).not.toContain("setupCheck");
  });

  it("summarizes the event log for one mailbox or every one", async () => {
    const { view, mailbox, events } = copilotView();
    const { invoke } = toolsOver(view);

    const every = await invoke("email_channel_events", {});
    expect(every).toEqual({
      configured: true,
      summaries: [{ mailboxId: mailbox.id, window: "24h", byDisposition: { ingest_only: 4, drop: 1 }, failed: 1, lastReceivedAt: "2026-10-03T11:00:00.000Z" }],
    });
    await invoke("email_channel_events", { mailboxId: mailbox.id, windowHours: 72 });
    expect(events.summarize).toHaveBeenLastCalledWith(WORKSPACE_ID, mailbox.id, 72);
    expect(() => toolsOver(view).byName.get("email_channel_events")?.inputSchema.parse({ windowHours: 0 })).toThrow();
  });

  it("reads an email conversation's facts with counts in place of addresses and no raw content", async () => {
    const { view, mailbox } = copilotView();
    const { invoke } = toolsOver(view);

    const output = await invoke("email_conversation_facts", { conversationId: CONVERSATION_ID });

    expect(output).toEqual({
      facts: {
        mailbox: { id: mailbox.id, address: "support@customer.test", displayName: "Support", engagementMode: "operator_only" },
        participant: { displayName: "Alice Example" },
        latest: { subject: "Question about my order", ccCount: 1, inboundAt: "2026-10-03T11:00:00.000Z" },
        sending: { state: "ok" },
        sendBudget: { used: 0, limit: 3, renewedAt: null },
        messages: [{
          messageId: "33333333-3333-4333-8333-333333333333",
          direction: "inbound",
          subject: "Question about my order",
          ccCount: 1,
          attachments: [{ name: "receipt.pdf", contentType: "application/pdf", sizeBytes: 1024 }],
          hasRaw: true,
        }],
      },
    });
    expect(leaked(output)).toEqual([]);
    expect(JSON.stringify(output)).not.toContain("rawDeliveryId");
    expect(await invoke("email_conversation_facts", { conversationId: "55555555-5555-4555-8555-555555555555" })).toEqual({ facts: null });
  });

  it("names the conversation it reads as the dashboard handoff", async () => {
    const descriptor = toolsOver(copilotView().view).byName.get("email_conversation_facts");

    expect(await descriptor?.describeEntity?.({ conversationId: CONVERSATION_ID }, context)).toEqual({ type: "conversation", id: CONVERSATION_ID });
  });

  it("says the channel is not configured when the deployment has no email provider", async () => {
    const { invoke } = toolsOver(null);

    expect(await invoke("email_channel_configuration", {})).toEqual({
      configured: false,
      supportedModes: [],
      defaultMode: null,
      domains: [],
      mailboxes: [],
    });
    expect(await invoke("email_channel_events", {})).toEqual({ configured: false, summaries: [] });
    expect(await invoke("email_conversation_facts", { conversationId: CONVERSATION_ID })).toEqual({ facts: null });
  });
});

/** A channel view whose reads are larger than one tool result may carry, so each is compacted. */
const oversizedChannel = (): CopilotEmailChannelPort => {
  const mailboxView = (index: number) => ({
    id: `mailbox-${index}`,
    address: `support${index}@customer.test`,
    agentId: null,
    engagementMode: "draft" as const,
    enabled: true,
    receivingState: "ok" as const,
    lastReceivedAt: null,
    sendingState: "ok" as const,
    threadSendBudget: 3,
    hourlyGenerationBudget: 30,
  });
  const summary = (index: number) => ({ mailboxId: `mailbox-${index}`, window: "24h", byDisposition: { ingest_only: 1 }, failed: 0, lastReceivedAt: null });
  const message = (index: number) => ({
    messageId: `message-${index}`,
    direction: "inbound" as const,
    subject: "s".repeat(600),
    ccCount: 0,
    attachments: [],
    hasRaw: false,
  });
  return {
    configuration: async () => ({ supportedModes: ["draft"], defaultMode: "draft", domains: [], mailboxes: Array.from({ length: 41 }, (_, index) => mailboxView(index)) }),
    eventSummaries: async () => ({ summaries: Array.from({ length: 41 }, (_, index) => summary(index)) }),
    conversationFacts: async () => ({
      facts: {
        mailbox: { id: "mailbox-0", address: "support@customer.test", displayName: "Support", engagementMode: "draft" as const },
        participant: { displayName: null },
        latest: { subject: "s".repeat(600), ccCount: 0, inboundAt: null },
        sending: { state: "ok" as const },
        sendBudget: { used: 0, limit: 3, renewedAt: null },
        messages: Array.from({ length: 41 }, (_, index) => message(index)),
      },
    }),
  };
};

describe("email channel Ray tools over a compacted result", () => {
  const invokeRaw = async (name: string, input: unknown) => {
    const descriptor = createEmailChannelCopilotTools({ emailChannel: oversizedChannel() }).find((candidate) => candidate.name === name);
    if (!descriptor) throw new Error(`No ${name} tool`);
    const output = await descriptor.createTool(context).invoke(descriptor.inputSchema.parse(input), {} as never);
    return { descriptor, output };
  };

  it.each([
    ["email_channel_configuration", {}],
    ["email_channel_events", {}],
    ["email_conversation_facts", { conversationId: CONVERSATION_ID }],
  ])("%s validates against its own output schema and says what it cut", async (name, input) => {
    const { descriptor, output } = await invokeRaw(name, input);

    const parsed = descriptor.outputSchema.safeParse(output);

    expect(parsed.success).toBe(true);
    expect((parsed.data as { truncation?: unknown }).truncation).toEqual(expect.objectContaining({ truncated: true }));
  });
});

describe("held_replies Ray tool", () => {
  it("lists the workspace's held replies waiting for a teammate as the signed-in teammate, under an object root", async () => {
    const port = heldRepliesPort();
    const { invoke } = toolsOver(null, port);

    const output = await invoke("held_replies", {});

    expect(output).toEqual({ heldReply: null, items: [heldReplyProjection], nextCursor: "next-page" });
    expect(port.list).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, accountId: "account-1", userId: "operator-1" },
      { attention: "open", limit: 20 },
    );
    expect(port.current).not.toHaveBeenCalled();
  });

  it("passes the listing filters and the page through", async () => {
    const port = heldRepliesPort();
    const { invoke, byName } = toolsOver(null, port);

    await invoke("held_replies", { attention: "all", agentId: "77777777-7777-4777-8777-777777777777", cursor: "next-page", limit: 5 });

    expect(port.list).toHaveBeenCalledWith(expect.anything(), {
      attention: "all",
      agentId: "77777777-7777-4777-8777-777777777777",
      cursor: "next-page",
      limit: 5,
    });
    expect(() => byName.get("held_replies")?.inputSchema.parse({ limit: 41 })).toThrow();
    expect(() => byName.get("held_replies")?.inputSchema.parse({ attention: "closed" })).toThrow();
  });

  it("reads one conversation's current held reply under the heldReply root, and null when it has none", async () => {
    const port = heldRepliesPort();
    const { invoke } = toolsOver(null, port);

    expect(await invoke("held_replies", { conversationId: CONVERSATION_ID }))
      .toEqual({ heldReply: heldReplyProjection, items: [], nextCursor: null });
    expect(port.current).toHaveBeenCalledWith(
      { workspaceId: WORKSPACE_ID, accountId: "account-1", userId: "operator-1" },
      CONVERSATION_ID,
    );
    expect(await invoke("held_replies", { conversationId: "55555555-5555-4555-8555-555555555555" }))
      .toEqual({ heldReply: null, items: [], nextCursor: null });
    expect(port.list).not.toHaveBeenCalled();
  });

  it("carries the draft as the operator view shows it and nothing behind it: no presentation, trace, policy, review ref or teammate", async () => {
    const output = await toolsOver(null).invoke("held_replies", { conversationId: CONVERSATION_ID });

    const serialized = JSON.stringify(output);
    for (const internal of ["presentation", "citations", "turnTrace", "email_mailbox:", "email:review:1", "operator-2", "releaserUserId", "workspaceId"]) {
      expect(serialized).not.toContain(internal);
    }
  });

  it("bounds a long draft and says it did", async () => {
    const draftText = "a".repeat(2_000);
    const { invoke } = toolsOver(null, heldRepliesPort([heldReplyView({ draftText })]));

    const output = await invoke("held_replies", {}) as { items: Array<{ draftText: string }>; truncation?: { truncated: boolean } };

    expect(output.items[0].draftText.length).toBeLessThan(draftText.length);
    expect(output.truncation).toEqual(expect.objectContaining({ truncated: true }));
  });

  it("names the conversation it reads, or the agent it lists, as the dashboard handoff", async () => {
    const descriptor = toolsOver(null).byName.get("held_replies");

    expect(await descriptor?.describeEntity?.({ conversationId: CONVERSATION_ID }, context)).toEqual({ type: "conversation", id: CONVERSATION_ID });
    expect(await descriptor?.describeEntity?.({ agentId: "77777777-7777-4777-8777-777777777777" }, context))
      .toEqual({ type: "agent", id: "77777777-7777-4777-8777-777777777777" });
    expect(descriptor?.dashboardSubject).toEqual({ type: "needs_attention" });
  });

  it("reads none where no held replies are composed into Ray", async () => {
    const { invoke } = toolsOver(null, null);

    expect(await invoke("held_replies", {})).toEqual({ heldReply: null, items: [], nextCursor: null });
    expect(await invoke("held_replies", { conversationId: CONVERSATION_ID })).toEqual({ heldReply: null, items: [], nextCursor: null });
  });
});
