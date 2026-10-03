import { describe, expect, it, vi } from "vitest";

import {
  bindDeliveryFailureRecorder,
  DeliveryFailures,
  type DeliveryFailureReadStore,
  type DeliveryFailureRecord,
  type DeliveryFailureUnitOfWork,
  type DeliveryFailureWriteScope,
  type DeliveryFailureWriteStore,
} from "../../src/modules/customerReplyDelivery/public.js";
import type { ConversationActivityEvent } from "../../src/modules/conversationActivity/contracts/index.js";
import { CursorPaginationError } from "../../src/shared/domain/cursorPagination.js";

const WORKSPACE = "workspace-1";
const CONVERSATION = "conversation-1";
const OTHER_CONVERSATION = "conversation-2";
const TEAMMATE = "user-1";

/** The failures table as the write store sees it: one open failure per conversation and message. */
const failureTable = () => {
  const rows: DeliveryFailureRecord[] = [];
  let opened = Date.parse("2026-10-03T10:00:00.000Z");
  const openOn = (conversationId: string, messageId: string | null) => (row: DeliveryFailureRecord) =>
    row.clearedAt === null && row.conversationId === conversationId && row.messageId === messageId;
  const store: DeliveryFailureWriteStore = {
    async insertOpen(input) {
      if (rows.some(openOn(input.conversationId, input.messageId))) {
        return null;
      }
      opened += 1000;
      const row: DeliveryFailureRecord = {
        id: `failure-${rows.length + 1}`,
        ...input,
        openedAt: new Date(opened),
        clearedAt: null,
        clearedByUserId: null,
        clearReason: null,
      };
      rows.push(row);
      return { ...row };
    },
    async retargetOpen(input) {
      const row = rows.find((candidate) => openOn(input.conversationId, input.messageId)(candidate) && candidate.kind !== input.kind);
      if (!row) {
        return null;
      }
      Object.assign(row, { kind: input.kind, detailCode: input.detailCode });
      return { ...row };
    },
    async clearOpen(input) {
      const cleared = rows.filter((row) =>
        row.clearedAt === null
        && row.conversationId === input.conversationId
        && (input.messageId === null || row.messageId === input.messageId));
      for (const row of cleared) {
        Object.assign(row, { clearedAt: new Date(opened), clearReason: input.reason, clearedByUserId: input.clearedByUserId });
      }
      return cleared.map((row) => ({ ...row }));
    },
    async acknowledgeOpen(input) {
      const row = rows.find((candidate) => candidate.id === input.failureId && candidate.workspaceId === input.workspaceId && candidate.clearedAt === null);
      if (!row) {
        return null;
      }
      Object.assign(row, { clearedAt: new Date(opened), clearReason: "acknowledged", clearedByUserId: input.userId });
      return { ...row };
    },
  };
  return { rows, store };
};

const setup = () => {
  const table = failureTable();
  const activities: ConversationActivityEvent[] = [];
  const scope: DeliveryFailureWriteScope = {
    failures: table.store,
    activity: { record: async (event) => { activities.push(event); } },
  };
  const writes: DeliveryFailureUnitOfWork = { run: vi.fn(async (work) => work(scope)) };
  const reads: DeliveryFailureReadStore = {
    listOpen: vi.fn(async () => []),
    listAll: vi.fn(async () => []),
    find: vi.fn(async () => null),
  };
  const failures = new DeliveryFailures({ writes, reads });
  const open = (messageId: string | null, kind: DeliveryFailureRecord["kind"] = "bounced", conversationId = CONVERSATION) =>
    failures.open({ workspaceId: WORKSPACE, conversationId, messageId, provider: "resend", kind, detailCode: null });
  return { ...table, activities, scope, writes, reads, failures, open };
};

const failedActivity = (failureId: string, messageId: string | null, failureKind: string) => ({
  kind: "delivery_failed",
  conversationId: CONVERSATION,
  workspaceId: WORKSPACE,
  actorUserId: null,
  detail: { failureId, messageId, failureKind },
});

const clearedActivity = (failureId: string, messageId: string | null, reason: string, actorUserId: string | null = null) => ({
  kind: "delivery_failure_cleared",
  conversationId: CONVERSATION,
  workspaceId: WORKSPACE,
  actorUserId,
  detail: { failureId, messageId, reason },
});

describe("DeliveryFailures recorder", () => {
  it("opens one failure per open message and records it once, however often the channel reports it", async () => {
    const { rows, activities, writes, open } = setup();

    await open("message-1", "uncertain");
    await open("message-1", "uncertain");
    await open("message-1", "failed");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: "message-1", kind: "uncertain", provider: "resend", clearedAt: null });
    expect(activities).toEqual([failedActivity("failure-1", "message-1", "uncertain")]);
    expect(writes.run).toHaveBeenCalledTimes(3);
  });

  it("opens a new failure on a message once its last one cleared, and one per message alongside", async () => {
    const { rows, activities, failures, open } = setup();

    await open("message-1");
    await failures.clear({ conversationId: CONVERSATION, messageId: "message-1", reason: "provider_evidence" });
    await open("message-1", "failed");
    await open("message-2");

    expect(rows.filter((row) => row.clearedAt === null).map((row) => [row.messageId, row.kind])).toEqual([
      ["message-1", "failed"],
      ["message-2", "bounced"],
    ]);
    expect(activities.filter((event) => event.kind === "delivery_failed")).toHaveLength(3);
  });

  it("retargets the open failure when provider evidence settles an uncertain send, recording the new kind", async () => {
    const { rows, activities, failures, open } = setup();
    await open("message-1", "uncertain");

    await failures.retarget({ conversationId: CONVERSATION, messageId: "message-1", kind: "bounced", detailCode: "suppressed" });
    await failures.retarget({ conversationId: CONVERSATION, messageId: "message-1", kind: "bounced", detailCode: "suppressed" });

    expect(rows).toEqual([expect.objectContaining({ id: "failure-1", kind: "bounced", detailCode: "suppressed", clearedAt: null })]);
    expect(activities).toEqual([
      failedActivity("failure-1", "message-1", "uncertain"),
      failedActivity("failure-1", "message-1", "bounced"),
    ]);
  });

  it("retargets nothing when the message has no open failure", async () => {
    const { rows, activities, failures, open } = setup();
    await open("message-1", "uncertain");
    await failures.clear({ conversationId: CONVERSATION, messageId: "message-1", reason: "operator_resolved", userId: TEAMMATE });
    activities.length = 0;

    await failures.retarget({ conversationId: CONVERSATION, messageId: "message-1", kind: "failed", detailCode: null });
    await failures.retarget({ conversationId: CONVERSATION, messageId: "message-2", kind: "failed", detailCode: null });

    expect(rows).toEqual([expect.objectContaining({ kind: "uncertain" })]);
    expect(activities).toEqual([]);
  });

  it("clears every open failure on the conversation when a later send is delivered", async () => {
    const { rows, activities, failures, open } = setup();
    await open("message-1", "halted");
    await open("message-2", "bounced");
    await open("message-3", "failed", OTHER_CONVERSATION);
    activities.length = 0;

    const cleared = await failures.clear({ conversationId: CONVERSATION, messageId: null, reason: "later_delivery" });

    expect(cleared).toBe(2);
    expect(rows.map((row) => [row.messageId, row.clearReason, row.clearedByUserId])).toEqual([
      ["message-1", "later_delivery", null],
      ["message-2", "later_delivery", null],
      ["message-3", null, null],
    ]);
    expect(activities).toEqual([
      clearedActivity("failure-1", "message-1", "later_delivery"),
      clearedActivity("failure-2", "message-2", "later_delivery"),
    ]);
  });

  it("clears only the message's failure on provider evidence", async () => {
    const { rows, activities, failures, open } = setup();
    await open("message-1", "uncertain");
    await open("message-2", "uncertain");
    activities.length = 0;

    const cleared = await failures.clear({ conversationId: CONVERSATION, messageId: "message-2", reason: "provider_evidence" });

    expect(cleared).toBe(1);
    expect(rows.map((row) => row.clearReason)).toEqual([null, "provider_evidence"]);
    expect(activities).toEqual([clearedActivity("failure-2", "message-2", "provider_evidence")]);
  });

  it("names the teammate who resolved a failure, on the row and as the activity's actor", async () => {
    const { rows, activities, failures, open } = setup();
    await open("message-1", "uncertain");
    activities.length = 0;

    const cleared = await failures.clear({
      conversationId: CONVERSATION,
      messageId: "message-1",
      reason: "operator_resolved",
      userId: TEAMMATE,
    });

    expect(cleared).toBe(1);
    expect(rows[0]).toMatchObject({ clearReason: "operator_resolved", clearedByUserId: TEAMMATE });
    expect(activities).toEqual([clearedActivity("failure-1", "message-1", "operator_resolved", TEAMMATE)]);
  });

  it("clears nothing and records nothing when no failure is open", async () => {
    const { activities, failures } = setup();

    await expect(failures.clear({ conversationId: CONVERSATION, messageId: null, reason: "later_delivery" })).resolves.toBe(0);
    expect(activities).toEqual([]);
  });

  it("binds to a transaction its caller holds, writing there without opening its own", async () => {
    const { rows, activities, scope, writes } = setup();
    const recorder = bindDeliveryFailureRecorder(scope);

    await recorder.open({
      workspaceId: WORKSPACE,
      conversationId: CONVERSATION,
      messageId: "message-1",
      provider: "resend",
      kind: "halted",
      detailCode: "domain_removed",
    });
    await recorder.clear({ conversationId: CONVERSATION, messageId: "message-1", reason: "operator_resolved", userId: TEAMMATE });

    expect(writes.run).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({ detailCode: "domain_removed", clearReason: "operator_resolved" })]);
    expect(activities.map((event) => event.kind)).toEqual(["delivery_failed", "delivery_failure_cleared"]);
  });

  it("fails the change when its activity cannot be recorded", async () => {
    const { scope } = setup();
    const recorder = bindDeliveryFailureRecorder({
      ...scope,
      activity: { record: async () => { throw new Error("activity write failed"); } },
    });

    await expect(recorder.open({
      workspaceId: WORKSPACE,
      conversationId: CONVERSATION,
      messageId: "message-1",
      provider: "resend",
      kind: "failed",
      detailCode: null,
    })).rejects.toThrow("activity write failed");
  });
});

describe("DeliveryFailures acknowledgement", () => {
  it("clears the workspace's open failure as acknowledged by the teammate, with the activity naming them", async () => {
    const { failures, rows, activities, open } = setup();
    await open("message-1");
    const [failure] = rows;

    const acknowledged = await failures.acknowledge({ workspaceId: WORKSPACE, failureId: failure.id, userId: TEAMMATE });

    expect(acknowledged).toMatchObject({ id: failure.id, clearReason: "acknowledged", clearedByUserId: TEAMMATE });
    expect(activities.at(-1)).toEqual({
      kind: "delivery_failure_cleared",
      conversationId: CONVERSATION,
      workspaceId: WORKSPACE,
      actorUserId: TEAMMATE,
      detail: { failureId: failure.id, messageId: "message-1", reason: "acknowledged" },
    });
  });

  it("acknowledges nothing, and records nothing, for a cleared failure or another workspace's", async () => {
    const { failures, rows, activities, open } = setup();
    await open("message-1");
    const [failure] = rows;
    await failures.acknowledge({ workspaceId: WORKSPACE, failureId: failure.id, userId: TEAMMATE });
    const recorded = activities.length;

    await expect(failures.acknowledge({ workspaceId: WORKSPACE, failureId: failure.id, userId: TEAMMATE })).resolves.toBeNull();
    await expect(failures.acknowledge({ workspaceId: "workspace-2", failureId: failure.id, userId: TEAMMATE })).resolves.toBeNull();
    expect(activities).toHaveLength(recorded);
  });
});

describe("DeliveryFailures reader", () => {
  const failure = (id: string, openedAt: string): DeliveryFailureRecord => ({
    id,
    workspaceId: WORKSPACE,
    conversationId: CONVERSATION,
    messageId: `${id}-message`,
    provider: "resend",
    kind: "bounced",
    detailCode: null,
    openedAt: new Date(openedAt),
    clearedAt: null,
    clearedByUserId: null,
    clearReason: null,
  });

  const reader = (pages: DeliveryFailureRecord[][]) => {
    const listOpen = vi.fn<DeliveryFailureReadStore["listOpen"]>();
    const listAll = vi.fn<DeliveryFailureReadStore["listAll"]>();
    for (const page of pages) {
      listOpen.mockResolvedValueOnce(page);
      listAll.mockResolvedValueOnce(page);
    }
    const failures = new DeliveryFailures({
      writes: { run: vi.fn() },
      reads: { listOpen, listAll, find: vi.fn() },
    });
    return { failures, listOpen, listAll };
  };

  it("filters to one agent's conversations and pages newest first through an opaque cursor", async () => {
    const newest = failure("failure-3", "2026-10-03T10:00:03.000Z");
    const middle = failure("failure-2", "2026-10-03T10:00:02.000Z");
    const oldest = failure("failure-1", "2026-10-03T10:00:01.000Z");
    const { failures, listOpen } = reader([[newest, middle, oldest], [oldest]]);

    const first = await failures.listOpen(WORKSPACE, { agentId: "agent-1", limit: 2 });

    expect(listOpen).toHaveBeenLastCalledWith(WORKSPACE, { agentId: "agent-1", after: null, limit: 3 });
    expect(first.items).toEqual([newest, middle]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await failures.listOpen(WORKSPACE, { agentId: "agent-1", cursor: first.nextCursor!, limit: 2 });

    expect(listOpen).toHaveBeenLastCalledWith(WORKSPACE, {
      agentId: "agent-1",
      after: { openedAt: middle.openedAt, id: "failure-2" },
      limit: 3,
    });
    expect(second).toEqual({ items: [oldest], nextCursor: null });
  });

  it("lists every agent's failures without an agent filter", async () => {
    const { failures, listOpen } = reader([[]]);

    await expect(failures.listOpen(WORKSPACE, { limit: 50 })).resolves.toEqual({ items: [], nextCursor: null });
    expect(listOpen).toHaveBeenCalledWith(WORKSPACE, { agentId: undefined, after: null, limit: 51 });
  });

  it("reads the cleared failures too when asked for every state", async () => {
    const cleared = { ...failure("failure-1", "2026-10-03T10:00:01.000Z"), clearedAt: new Date("2026-10-03T11:00:00.000Z"), clearReason: "acknowledged" as const };
    const { failures, listOpen, listAll } = reader([[cleared]]);

    await expect(failures.list(WORKSPACE, { state: "all", limit: 10 })).resolves.toEqual({ items: [cleared], nextCursor: null });
    expect(listAll).toHaveBeenCalledWith(WORKSPACE, { agentId: undefined, after: null, limit: 11 });
    expect(listOpen).not.toHaveBeenCalled();
  });

  it("refuses a cursor no read issued", async () => {
    const { failures, listOpen } = reader([]);

    await expect(failures.listOpen(WORKSPACE, { cursor: "not-a-cursor", limit: 10 })).rejects.toBeInstanceOf(CursorPaginationError);
    expect(listOpen).not.toHaveBeenCalled();
  });
});
