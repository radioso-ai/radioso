import { describe, expect, it, vi } from "vitest";

import type { HeldReplyView } from "../../../src/modules/handoff/public.js";
import {
  readOpenDeliveryFailures,
  readOpenHeldReplies,
  type CopilotDeliveryFailure,
} from "../../../src/modules/operatorCopilot/tools/escalationSources.js";

const BACKLOG = 1_001;
const PAGE = 100;
const START = Date.parse("2026-10-01T00:00:00.000Z");

/** Row `index` waited longest at 0: the backlog's oldest row, which a newest-first reader serves last. */
const waitedSince = (index: number): Date => new Date(START + index * 60_000);

/** A newest-first, cursor-paged reader over `rows`, as the owning modules serve them. */
const newestFirstPages = <TRow>(rows: readonly TRow[], since: (row: TRow) => Date) => {
  const ordered = [...rows].sort((left, right) => since(right).getTime() - since(left).getTime());
  return vi.fn(async (cursor: string | undefined, limit: number) => {
    const start = cursor === undefined ? 0 : Number(cursor);
    const items = ordered.slice(start, start + limit);
    const next = start + limit;
    return { items, nextCursor: next < ordered.length ? String(next) : null };
  });
};

const failure = (index: number): CopilotDeliveryFailure => ({
  conversationId: `conversation-${index}`,
  kind: "bounced",
  detailCode: null,
  openedAt: waitedSince(index),
});

const heldReply = (index: number): HeldReplyView => ({
  id: `held-${index}`,
  conversationId: `conversation-${index}`,
  agentId: null,
  state: "pending",
  holdReason: "draft_mode",
  facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false, reason: null } },
  dependsOnSuppressedAction: false,
  suppressedEffects: [],
  draftText: "Draft",
  editedText: null,
  answersMessageId: `message-${index}`,
  releasedMessageId: null,
  createdAt: waitedSince(index),
  decidedAt: null,
  releaserUserId: null,
  editorUserId: null,
  discardedByUserId: null,
  supersededReason: null,
  attentionOpen: true,
});

const backlog = <TRow>(row: (index: number) => TRow): TRow[] => Array.from({ length: BACKLOG }, (_, index) => row(index));

describe("escalation sources over a backlog wider than the ranking window", () => {
  it("counts every open delivery failure and ranks the longest wait first", async () => {
    const page = newestFirstPages(backlog(failure), (row) => row.openedAt);
    const port = { listOpen: vi.fn((_workspaceId: string, query: { cursor?: string; limit: number }) => page(query.cursor, query.limit)) };

    const read = await readOpenDeliveryFailures(port, "workspace-1", null);

    expect(read.total).toBe(BACKLOG);
    expect(read.items[0]).toEqual(failure(0));
    expect(read.items.map((item) => item.openedAt.getTime())).toEqual([...read.items.map((item) => item.openedAt.getTime())].sort((a, b) => a - b));
    expect(read.items.length).toBeLessThan(BACKLOG);
    expect(port.listOpen).toHaveBeenCalledTimes(Math.ceil(BACKLOG / PAGE));
  });

  it("counts every open held reply and ranks the longest wait first", async () => {
    const page = newestFirstPages(backlog(heldReply), (row) => row.createdAt);
    const port = {
      list: vi.fn((_actor: unknown, query: { cursor?: string; limit: number }) => page(query.cursor, query.limit)),
      current: vi.fn(async () => ({ heldReply: null })),
    };

    const read = await readOpenHeldReplies(port, { workspaceId: "workspace-1", accountId: "account-1", userId: "user-1" }, null);

    expect(read.total).toBe(BACKLOG);
    expect(read.items[0]?.id).toBe("held-0");
    expect(read.items.length).toBeLessThan(BACKLOG);
    expect(port.list).toHaveBeenCalledTimes(Math.ceil(BACKLOG / PAGE));
  });
});
