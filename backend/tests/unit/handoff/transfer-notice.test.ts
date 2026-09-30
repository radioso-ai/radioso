import { describe, expect, it, vi, type Mock } from "vitest";

import type { ActionRequestRecord } from "../../../src/db/repositories/actionRequestRepository.js";
import { ActionDispatcher, ActionHandlerRegistry } from "../../../src/modules/chat/services/actions/actionDispatcher.js";
import {
  CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
  ConversationTransferNoticeActionHandler,
  transferNoticeRequest,
} from "../../../src/modules/handoff/public.js";

const transfer = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  ownershipVersion: 4,
  actorUserId: "user-dana",
  recipientUserId: "user-fox",
};

const recordingLogger = () => ({ warn: vi.fn(), info: vi.fn() });

type SendMail = (message: { to: string; text: string }) => Promise<{ dispatched: boolean }>;

describe("transferNoticeRequest", () => {
  it("builds the outbox row for the teammate a conversation was handed to, pinned to the version it produced", () => {
    expect(transferNoticeRequest(transfer)).toEqual({
      type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE,
      payload: { recipientUserId: "user-fox", transferredByUserId: "user-dana", ownershipVersion: 4 },
      accountId: "account-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      idempotencyKey: "conversation-transfer:conversation-1:4",
    });
  });

  it("sends nothing when a teammate takes the conversation themselves", () => {
    expect(transferNoticeRequest({ ...transfer, recipientUserId: "user-dana" })).toBeNull();
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
  const payload = { recipientUserId: "user-fox", transferredByUserId: "user-dana", ownershipVersion: 4 };
  const users = {
    findById: vi.fn(async (userId: string) => {
      if (userId === "user-fox") return { email: "fox@example.com" };
      if (userId === "user-dana") return { email: "dana@example.com" };
      return null;
    }),
  };
  const workspaces = { findById: vi.fn(async () => ({ name: "Support", accountId: "account-1" })) };
  const ownedBy = (ownerUserId: string | null, version = 4) => ({
    load: vi.fn(async () => ({ workspaceId: "workspace-1", state: "human_owned" as const, ownerUserId, version })),
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
    ownershipVersion?: number;
    operators?: typeof teammates;
    workspaces?: { findById: () => Promise<{ name: string; accountId: string } | null> };
    errorReporter?: { report: Mock };
  } = {}) => {
    const mail = overrides.mail ?? { send: vi.fn<SendMail>(async () => ({ dispatched: true })) };
    const eligible = overrides.operators ?? teammates;
    const operators = {
      find: vi.fn(async (input: { userId: string }) => eligible.find((operator) => operator.userId === input.userId) ?? null),
    };
    const handler = new ConversationTransferNoticeActionHandler({
      users,
      workspaces: overrides.workspaces ?? workspaces,
      ownership: ownedBy(overrides.ownerUserId === undefined ? "user-fox" : overrides.ownerUserId, overrides.ownershipVersion),
      operators,
      conversationLinks: { resolve: vi.fn(async () => (overrides.link === undefined ? "https://app.example.com/w/support/activity?itemId=conversation-1" : overrides.link)) },
      mail,
      appBaseUrl: "https://app.example.com",
      logger: overrides.logger ?? recordingLogger(),
      errorReporter: overrides.errorReporter,
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

  it("drops the notice when the conversation has since moved on from the recipient, and logs why", async () => {
    const logger = recordingLogger();
    const { handler, mail } = handlerWith({ ownerUserId: "user-dana", logger });

    await handler.handle({ payload, context });

    expect(mail.send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      {
        event: "conversation_transfer_notice_skipped",
        reason: "recipient_no_longer_owner",
        requestId: "request-1",
        conversationId: "conversation-1",
        ownershipVersion: 4,
      },
      expect.any(String),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("fox@example.com");
  });

  it("drops a notice a later transfer overtook, even once ownership comes back round to the recipient, and logs why", async () => {
    // A→B at v4 queued this notice; B→A (v5) and A→B (v6) followed, queueing a fresh one for v6.
    const logger = recordingLogger();
    const { handler, mail } = handlerWith({ ownerUserId: "user-fox", ownershipVersion: 6, logger });

    await handler.handle({ payload, context });

    expect(mail.send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      {
        event: "conversation_transfer_notice_skipped",
        reason: "stale_ownership_version",
        requestId: "request-1",
        conversationId: "conversation-1",
        ownershipVersion: 4,
      },
      expect.any(String),
    );
  });

  it("drops a notice queued without the version it belongs to", async () => {
    const { handler, mail } = handlerWith();

    await handler.handle({ payload: { recipientUserId: "user-fox", transferredByUserId: "user-dana" }, context });

    expect(mail.send).not.toHaveBeenCalled();
  });

  it("looks the recipient and the sender up one by one rather than listing the workspace", async () => {
    const { handler, operators } = handlerWith();

    await handler.handle({ payload, context });

    expect(operators.find.mock.calls.map(([input]) => input)).toEqual([
      { accountId: "account-1", workspaceId: "workspace-1", userId: "user-fox" },
      { accountId: "account-1", workspaceId: "workspace-1", userId: "user-dana" },
    ]);
  });

  it("logs a failed read before sending with ids only, and rethrows so the outbox retries", async () => {
    const logger = recordingLogger();
    const { handler } = handlerWith({
      logger,
      workspaces: { findById: async () => { throw new Error("pool timeout"); } },
    });

    await expect(handler.handle({ payload, context })).rejects.toThrow("pool timeout");

    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: "conversation_transfer_notice_read_failed",
        requestId: "request-1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        attempt: 1,
        errorClass: "Error",
      },
      expect.any(String),
    );
  });

  it("reports a notice that exhausted its retries, and only then", async () => {
    const errorReporter = { report: vi.fn(async () => undefined) };
    const logger = recordingLogger();
    const { handler } = handlerWith({ errorReporter, logger });

    await handler.recordFailureOutcome({ payload, context, outcome: "retry", error: "provider down" });
    expect(errorReporter.report).not.toHaveBeenCalled();

    await handler.recordFailureOutcome({ payload, context: { ...context, attempt: 5 }, outcome: "failed", error: "fox@example.com rejected" });

    expect(errorReporter.report).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "action.conversation_transfer_notice.delivery_failed",
      severity: "error",
      metadata: { workspaceId: "workspace-1", conversationId: "conversation-1", requestId: "request-1" },
    }));
    expect(JSON.stringify(errorReporter.report.mock.calls)).not.toContain("fox@example.com");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "conversation_transfer_notice_failed", requestId: "request-1", attempt: 5 }),
      expect.any(String),
    );
  });

  it("drops the notice when the recipient is no longer a teammate who can own it, and logs why", async () => {
    const logger = recordingLogger();
    const { handler, mail } = handlerWith({ operators: [{ userId: "user-dana", label: "dana@example.com" }], logger });

    await handler.handle({ payload, context });

    expect(mail.send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      {
        event: "conversation_transfer_notice_skipped",
        reason: "recipient_not_eligible",
        requestId: "request-1",
        conversationId: "conversation-1",
        ownershipVersion: 4,
      },
      expect.any(String),
    );
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
  it("delivers the notice a transfer queued", async () => {
    const queued: ActionRequestRecord[] = [];
    const outbox = {
      enqueue: vi.fn(async (input: NonNullable<ReturnType<typeof transferNoticeRequest>>) => {
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
      ownership: { load: async () => ({ workspaceId: "workspace-1", state: "human_owned" as const, ownerUserId: "user-fox", version: 4 }) },
      operators: {
        find: async ({ userId }: { userId: string }) =>
          [{ userId: "user-dana", label: "Dana Scully" }, { userId: "user-fox", label: "Fox Mulder" }]
            .find((operator) => operator.userId === userId) ?? null,
      },
      conversationLinks: { resolve: async () => "https://app.example.com/w/support/activity?itemId=conversation-1" },
      mail,
      logger: recordingLogger(),
    });
    const worker = new ActionDispatcher(
      outbox,
      new ActionHandlerRegistry([{ type: CONVERSATION_TRANSFER_NOTICE_ACTION_TYPE, handler }]),
    );

    await outbox.enqueue(transferNoticeRequest(transfer)!);
    const outcome = await worker.dispatchPending();

    expect(outcome).toEqual({ dispatched: 1, retried: 0, failed: 0 });
    expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: "fox@example.com", kind: "conversation_transfer" }));
    expect(outbox.markDispatched).toHaveBeenCalledWith("request-1", 1);
  });
});
