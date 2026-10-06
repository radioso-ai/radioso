import { describe, expect, it, vi } from "vitest";

import { DeliveryFailures, type DeliveryFailureRecord } from "../../../src/modules/customerReplyDelivery/public.js";
import { HeldReplyService, type HeldReplyRecord } from "../../../src/modules/handoff/public.js";
import { readOpenDeliveryFailures, readOpenHeldReplies } from "../../../src/modules/operatorCopilot/tools/escalationSources.js";

const BACKLOG = 100_000;
const LISTED = 10;
const START = Date.parse("2026-10-01T00:00:00.000Z");
const WORKSPACE = "workspace-1";
const actor = { workspaceId: WORKSPACE, accountId: "account-1", userId: "user-1" };

/** Row `index` waited longest at 0. */
const waitedSince = (index: number): Date => new Date(START + index * 60_000);

/**
 * A store holding a backlog of open rows, oldest first. It answers the bounded oldest-first read
 * and the count; a caller that walked the newest-first pages instead would page it to exhaustion.
 */
const backlogStore = <TRow>(row: (index: number) => TRow) => {
  const rows = Array.from({ length: BACKLOG }, (_, index) => row(index));
  return {
    listOldestOpen: vi.fn(async (_workspaceId: string, query: { limit: number }) => rows.slice(0, query.limit)),
    countOpen: vi.fn(async () => rows.length),
    listOpen: vi.fn(async (): Promise<never> => { throw new Error("paged the backlog newest first"); }),
    listAll: vi.fn(async (): Promise<never> => { throw new Error("paged the backlog newest first"); }),
  };
};

const failureWait = (index: number): Pick<DeliveryFailureRecord, "id" | "conversationId" | "kind" | "detailCode" | "openedAt"> => ({
  id: `failure-${index}`,
  conversationId: `conversation-${index}`,
  kind: "bounced",
  detailCode: "mailbox_full",
  openedAt: waitedSince(index),
});

const heldReplyWait = (index: number): Pick<HeldReplyRecord, "id" | "conversationId" | "agentId" | "holdReason" | "createdAt"> => ({
  id: `held-${index}`,
  conversationId: `conversation-${index}`,
  agentId: "agent-1",
  holdReason: "draft_mode",
  createdAt: waitedSince(index),
});

const unused = {} as never;

describe("escalation sources over a backlog far wider than the rows listed", () => {
  it("reads the longest-waiting delivery failures as one bounded read and a count", async () => {
    const store = backlogStore(failureWait);
    const failures = new DeliveryFailures({ writes: unused, reads: { ...store, find: vi.fn() } });

    const read = await readOpenDeliveryFailures(failures, WORKSPACE, null, LISTED);

    expect(read.total).toBe(BACKLOG);
    expect(read.items).toEqual(Array.from({ length: LISTED }, (_, index) => failureWait(index)));
    expect(store.listOldestOpen).toHaveBeenCalledTimes(1);
    expect(store.listOldestOpen).toHaveBeenCalledWith(WORKSPACE, { agentId: undefined, limit: LISTED });
    expect(store.countOpen).toHaveBeenCalledTimes(1);
    expect(store.countOpen).toHaveBeenCalledWith(WORKSPACE, { agentId: undefined });
    expect(store.listOpen).not.toHaveBeenCalled();
  });

  it("narrows both the read and the count to one agent", async () => {
    const store = backlogStore(failureWait);
    const failures = new DeliveryFailures({ writes: unused, reads: { ...store, find: vi.fn() } });

    await readOpenDeliveryFailures(failures, WORKSPACE, "agent-1", LISTED);

    expect(store.listOldestOpen).toHaveBeenCalledWith(WORKSPACE, { agentId: "agent-1", limit: LISTED });
    expect(store.countOpen).toHaveBeenCalledWith(WORKSPACE, { agentId: "agent-1" });
  });

  it("reads the longest-waiting held replies as one bounded read and a count, with no draft among them", async () => {
    const store = backlogStore(heldReplyWait);
    const heldReplies = new HeldReplyService({
      conversations: unused,
      writes: unused,
      reads: { ...store, findByReviewRef: vi.fn(), current: vi.fn() },
      operatorIdentities: unused,
      customerReplyDelivery: unused,
      replies: unused,
      audit: unused,
    });

    const read = await readOpenHeldReplies(heldReplies, actor, "agent-1", LISTED);

    expect(read.total).toBe(BACKLOG);
    expect(read.items).toEqual(Array.from({ length: LISTED }, (_, index) => heldReplyWait(index)));
    expect(read.items.every((item) => !("draftText" in item) && !("draft" in item))).toBe(true);
    expect(store.listOldestOpen).toHaveBeenCalledTimes(1);
    expect(store.listOldestOpen).toHaveBeenCalledWith(WORKSPACE, { agentId: "agent-1", limit: LISTED });
    expect(store.countOpen).toHaveBeenCalledTimes(1);
    expect(store.countOpen).toHaveBeenCalledWith(WORKSPACE, { agentId: "agent-1" });
    expect(store.listOpen).not.toHaveBeenCalled();
  });
});
