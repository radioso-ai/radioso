import { describe, expect, it, vi, type Mock } from "vitest";

import type { ActionRequestRecord } from "../../../src/db/repositories/actionRequestRepository.js";
import { ActionDispatcher, ActionHandlerRegistry } from "../../../src/modules/chat/services/actions/actionDispatcher.js";
import {
  CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
  ConversationTransferNoticeActionHandler,
  ConversationTransferNotices,
} from "../../../src/modules/handoff/public.js";

const transfer = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  ownershipVersion: 4,
  actorUserId: "user-dana",
  recipientUserId: "user-fox",
};

const recordingLogger = () => ({ warn: vi.fn() });

type SendMail = (message: { to: string; text: string }) => Promise<{ dispatched: boolean }>;

describe("ConversationTransferNotices", () => {
  it("queues a notice for the teammate a conversation was handed to", async () => {
    const outbox = { enqueue: vi.fn(async () => ({ id: "request-1", duplicate: false })) };
    const notices = new ConversationTransferNotices({ outbox, logger: recordingLogger() });

    await expect(notices.queueForRecipient(transfer)).resolves.toBe(true);

    expect(outbox.enqueue).toHaveBeenCalledWith({
      type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
      payload: { recipientUserId: "user-fox", transferredByUserId: "user-dana" },
      accountId: "account-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      idempotencyKey: "conversation-transfer:conversation-1:4",
    });
  });

  it("sends nothing when a teammate takes the conversation themselves", async () => {
    const outbox = { enqueue: vi.fn(async () => ({ id: "request-1", duplicate: false })) };
    const notices = new ConversationTransferNotices({ outbox, logger: recordingLogger() });

    await expect(notices.queueForRecipient({ ...transfer, recipientUserId: "user-dana" })).resolves.toBe(false);

    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("never fails the transfer when the notice cannot be queued", async () => {
    const outbox = { enqueue: vi.fn(async () => { throw new Error("outbox unavailable"); }) };
    const logger = recordingLogger();
    const notices = new ConversationTransferNotices({ outbox, logger });

    await expect(notices.queueForRecipient(transfer)).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "conversation_transfer_notice_enqueue_failed",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        errorClass: "Error",
      }),
      expect.any(String),
    );
  });
});

describe("ConversationTransferNoticeActionHandler", () => {
  const context = {
    requestId: "request-1",
    workspaceId: "workspace-1",
    accountId: "account-1",
    conversationId: "conversation-1",
    idempotencyKey: "conversation-transfer:conversation-1:4",
    attempt: 1,
    skillName: null,
  };
  const payload = { recipientUserId: "user-fox", transferredByUserId: "user-dana" };
  const users = {
    findById: vi.fn(async (userId: string) => {
      if (userId === "user-fox") return { email: "fox@example.com" };
      if (userId === "user-dana") return { email: "dana@example.com" };
      return null;
    }),
  };
  const workspaces = { findById: vi.fn(async () => ({ name: "Support", accountId: "account-1" })) };
  const ownedBy = (ownerUserId: string | null) => ({
    load: vi.fn(async () => ({ workspaceId: "workspace-1", state: "human_owned" as const, ownerUserId })),
  });
  const teammates = [
    { userId: "user-dana", label: "dana@example.com" },
    { userId: "user-fox", label: "Fox Mulder" },
  ];

  const handlerWith = (overrides: {
    mail?: { send: Mock<SendMail> };
    link?: string | null;
    logger?: ReturnType<typeof recordingLogger>;
    ownerUserId?: string | null;
    operators?: typeof teammates;
  } = {}) => {
    const mail = overrides.mail ?? { send: vi.fn<SendMail>(async () => ({ dispatched: true })) };
    const operators = { list: vi.fn(async () => overrides.operators ?? teammates) };
    const handler = new ConversationTransferNoticeActionHandler({
      users,
      workspaces,
      ownership: ownedBy(overrides.ownerUserId === undefined ? "user-fox" : overrides.ownerUserId),
      operators,
      conversationLinks: { resolve: vi.fn(async () => (overrides.link === undefined ? "https://app.example.com/w/support/activity?itemId=conversation-1" : overrides.link)) },
      mail,
      appBaseUrl: "https://app.example.com",
      logger: overrides.logger ?? recordingLogger(),
    });
    return { handler, mail, operators };
  };

  it("emails the receiving teammate a link to the conversation, named by who handed it over", async () => {
    const { handler, mail } = handlerWith();

    await handler.handle({ payload, context });

    expect(mail.send).toHaveBeenCalledTimes(1);
    const message = mail.send.mock.calls[0][0];
    expect(message).toMatchObject({
      to: "fox@example.com",
      kind: "conversation_transfer",
      idempotencyKey: "conversation-transfer:conversation-1:4",
    });
    expect(message.text).toContain("https://app.example.com/w/support/activity?itemId=conversation-1");
    expect(message.text).toContain("dana@example.com");
    expect(message.text).toContain("Support");
  });

  it("still delivers the notice when the dashboard link cannot be resolved", async () => {
    const { handler, mail } = handlerWith({ link: null });

    await handler.handle({ payload, context });

    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: "fox@example.com" }));
  });

  it("drops the notice when the conversation has since moved on from the recipient", async () => {
    const { handler, mail } = handlerWith({ ownerUserId: "user-dana" });

    await handler.handle({ payload, context });

    expect(mail.send).not.toHaveBeenCalled();
  });

  it("drops the notice when the recipient is no longer a teammate who can own it", async () => {
    const { handler, mail } = handlerWith({ operators: [{ userId: "user-dana", label: "dana@example.com" }] });

    await handler.handle({ payload, context });

    expect(mail.send).not.toHaveBeenCalled();
  });

  it("names only a sender who is a teammate in the workspace", async () => {
    const { handler, mail } = handlerWith();

    await handler.handle({ payload: { ...payload, transferredByUserId: "user-elsewhere" }, context });

    const message = mail.send.mock.calls[0][0];
    expect(message.text).not.toContain("user-elsewhere");
    expect(message.text).toContain("A teammate handed you a conversation.");
  });

  it("logs a delivery failure without the address and rethrows so the outbox retries", async () => {
    const logger = recordingLogger();
    const { handler } = handlerWith({
      logger,
      mail: { send: vi.fn<SendMail>(async () => { throw new Error("provider down"); }) },
    });

    await expect(handler.handle({ payload, context })).rejects.toThrow("provider down");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "conversation_transfer_notice_delivery_failed",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        attempt: 1,
      }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("fox@example.com");
  });
});

describe("transfer notice through the action worker", () => {
  it("delivers the notice the transfer route queued", async () => {
    const queued: ActionRequestRecord[] = [];
    const outbox = {
      enqueue: vi.fn(async (input: Parameters<ConstructorParameters<typeof ConversationTransferNotices>[0]["outbox"]["enqueue"]>[0]) => {
        queued.push({
          id: `request-${queued.length + 1}`,
          type: input.type,
          payload: input.payload,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          conversationId: input.conversationId,
          idempotencyKey: input.idempotencyKey,
          status: "in_progress",
          attempts: 1,
          skillName: null,
        });
        return { id: `request-${queued.length}`, duplicate: false };
      }),
      claimPending: vi.fn(async () => queued.splice(0)),
      markDispatched: vi.fn(async () => true),
      recordFailure: vi.fn(async () => "failed" as const),
    };
    const mail = { send: vi.fn<SendMail>(async () => ({ dispatched: true })) };
    const handler = new ConversationTransferNoticeActionHandler({
      users: { findById: async (userId: string) => (userId === "user-fox" ? { email: "fox@example.com" } : { email: "dana@example.com" }) },
      workspaces: { findById: async () => ({ name: "Support", accountId: "account-1" }) },
      ownership: { load: async () => ({ workspaceId: "workspace-1", state: "human_owned" as const, ownerUserId: "user-fox" }) },
      operators: { list: async () => [{ userId: "user-dana", label: "Dana Scully" }, { userId: "user-fox", label: "Fox Mulder" }] },
      conversationLinks: { resolve: async () => "https://app.example.com/w/support/activity?itemId=conversation-1" },
      mail,
      logger: recordingLogger(),
    });
    const worker = new ActionDispatcher(
      outbox,
      new ActionHandlerRegistry([{ type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE, handler }]),
    );

    await new ConversationTransferNotices({ outbox, logger: recordingLogger() }).queueForRecipient(transfer);
    const outcome = await worker.dispatchPending();

    expect(outcome).toEqual({ dispatched: 1, retried: 0, failed: 0 });
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: "fox@example.com", kind: "conversation_transfer" }));
    expect(outbox.markDispatched).toHaveBeenCalledWith("request-1", 1);
  });
});
