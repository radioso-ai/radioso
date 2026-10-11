import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CLOSED_INBOX_ITEM_KINDS,
  CLOSING_ACTIVITY_KINDS,
  CONVERSATION_ACTIVITY_KINDS,
  FEEDBACK_ACTIVITY_KINDS,
  type ClosingActivityKind,
  type ClosingConversationActivityRecord,
  type ConversationActivityKind,
  type ConversationActivityRecord,
} from "../../src/modules/conversationActivity/contracts/index.js";
import {
  closedItemKind,
  presentActivity,
  visibleActivityKinds,
  visibleClosingKinds,
} from "../../src/modules/conversationActivity/presentation.js";
import {
  ConversationActivityReadService,
  type ConversationActivityStore,
} from "../../src/modules/conversationActivity/public.js";

const migrationsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/db/migrations");

// The quoted kinds inside the one SQL list `listPattern` captures, so the migrations stay the single
// source of truth the TypeScript lists are held to.
const quotedKindsIn = (file: string, listPattern: RegExp): string[] => {
  const sql = readFileSync(path.join(migrationsPath, file), "utf8");
  const list = listPattern.exec(sql)?.[1];
  if (list === undefined) {
    throw new Error(`${file}: kind list not found`);
  }
  return [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
};

const CHECK_KINDS = quotedKindsIn(
  "211_conversation_activity_kind_v2_add.sql",
  /conversation_activity_kind_v2_check CHECK \(kind IN \(([^)]*)\)\)/,
);
const CLOSED_INDEX_KINDS = quotedKindsIn(
  "213_conversation_activity_kind_v2_finish.sql",
  /conversation_activity_workspace_closed_v2_idx[\s\S]*?WHERE kind IN \(([^)]*)\)/,
);

const sorted = (kinds: readonly string[]): string[] => [...kinds].sort();

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000002";
const ACTOR_ID = "00000000-0000-4000-8000-000000000003";
const ANSWER_ID = "00000000-0000-4000-8000-000000000004";

const record = (kind: ConversationActivityKind, detail: Record<string, unknown> = {}): ConversationActivityRecord => ({
  id: `${kind}-id`,
  conversationId: CONVERSATION_ID,
  workspaceId: WORKSPACE_ID,
  kind,
  actorUserId: ACTOR_ID,
  subjectUserId: null,
  detail,
  createdAt: new Date("2026-10-03T12:00:00.000Z"),
});

const closingRecord = (kind: ClosingActivityKind): ClosingConversationActivityRecord => ({
  ...record(kind),
  kind,
  conversationTitle: null,
});

const readServiceOver = (closing: readonly ClosingConversationActivityRecord[]) => {
  const requested: (readonly ClosingActivityKind[])[] = [];
  const store: ConversationActivityStore = {
    listForConversation: () => Promise.resolve({ records: [], readAt: new Date() }),
    listRecentClosing: (_workspaceId, _limit, kinds) => {
      requested.push(kinds);
      return Promise.resolve(closing.filter((entry) => kinds.includes(entry.kind)));
    },
  };
  const service = new ConversationActivityReadService({
    store,
    teammateLabels: { labelsByUserIds: () => Promise.resolve(new Map([[ACTOR_ID, "Ada"]])) },
    previews: { previewsByConversationIds: () => Promise.resolve(new Map([[CONVERSATION_ID, "Where is my order?"]])) },
  });
  return { service, requested };
};

describe("conversation activity kinds", () => {
  it("names exactly the kinds the table's CHECK allows", () => {
    expect(CHECK_KINDS.length).toBeGreaterThan(0);
    expect(new Set(CONVERSATION_ACTIVITY_KINDS).size).toBe(CONVERSATION_ACTIVITY_KINDS.length);
    expect(sorted(CONVERSATION_ACTIVITY_KINDS)).toEqual(sorted(CHECK_KINDS));
  });

  it("closes Inbox items with exactly the kinds the recently-closed index covers", () => {
    expect(new Set(CLOSING_ACTIVITY_KINDS).size).toBe(CLOSING_ACTIVITY_KINDS.length);
    expect(sorted(CLOSING_ACTIVITY_KINDS)).toEqual(sorted(CLOSED_INDEX_KINDS));
  });

  it("maps every closing kind to the Inbox item it closes, and every item kind has a closing kind", () => {
    for (const kind of CLOSING_ACTIVITY_KINDS) {
      expect(CLOSED_INBOX_ITEM_KINDS, kind).toContain(closedItemKind(kind));
    }
    expect(sorted([...new Set(CLOSING_ACTIVITY_KINDS.map(closedItemKind))])).toEqual(sorted(CLOSED_INBOX_ITEM_KINDS));
    expect(closedItemKind("held_reply_released")).toBe("approval");
    expect(closedItemKind("delivery_failure_cleared")).toBe("delivery_failed");
  });

  it("gates only feedback kinds on the read scope", () => {
    expect(sorted(visibleActivityKinds({ includeFeedback: true }))).toEqual(sorted(CONVERSATION_ACTIVITY_KINDS));
    expect(sorted(visibleActivityKinds({ includeFeedback: false }))).toEqual(
      sorted(CONVERSATION_ACTIVITY_KINDS.filter((kind) => !(FEEDBACK_ACTIVITY_KINDS as readonly string[]).includes(kind))),
    );
    expect(sorted(visibleClosingKinds({ includeFeedback: true }))).toEqual(sorted(CLOSING_ACTIVITY_KINDS));
  });

  it.each(CONVERSATION_ACTIVITY_KINDS)("presents %s, with kind-specific fields only on their kinds", (kind) => {
    const isFeedback = (FEEDBACK_ACTIVITY_KINDS as readonly string[]).includes(kind);
    const entry = presentActivity(
      record(kind, {
        reason: "retrieval_miss",
        decision: { optionId: "yes", label: "Yes" },
        resolution: "content_fixed",
        assistantMessageId: ANSWER_ID,
      }),
      new Map([[ACTOR_ID, "Ada"]]),
    );

    expect(entry.kind).toBe(kind);
    expect(entry.createdAt).toBe("2026-10-03T12:00:00.000Z");
    expect(entry.actor).toEqual({ userId: ACTOR_ID, label: "Ada" });
    expect(entry.handoffReason).toBe(kind === "handoff_requested" ? "retrieval_miss" : null);
    expect(entry.decision).toEqual(kind === "approval_decided" ? { optionId: "yes", label: "Yes" } : null);
    expect(entry.resolution).toBe(isFeedback ? "content_fixed" : null);
    expect(entry.assistantMessageId).toBe(isFeedback ? ANSWER_ID : null);
  });

  it("presents a channel exception without leaking its delivery detail into other fields", () => {
    const entry = presentActivity(
      record("channel_exception", { code: "participant_mismatch", deliveryId: "delivery-1" }),
      new Map(),
    );

    expect(entry).toMatchObject({
      kind: "channel_exception",
      handoffReason: null,
      decision: null,
      resolution: null,
      assistantMessageId: null,
      subject: null,
      from: null,
    });
  });
});

describe("recently closed Inbox items", () => {
  it("reads the v2 closing kinds, so the query matches the v2 index predicate", async () => {
    const { service, requested } = readServiceOver([]);

    await service.listRecentlyClosed(WORKSPACE_ID, 20, { includeFeedback: true });

    expect(requested).toHaveLength(1);
    expect(sorted(requested[0])).toEqual(sorted(CLOSED_INDEX_KINDS));
  });

  it("drops only the feedback kinds for a caller without Quality access", async () => {
    const { service, requested } = readServiceOver([]);

    await service.listRecentlyClosed(WORKSPACE_ID, 20, { includeFeedback: false });

    expect(sorted(requested[0])).toEqual(
      sorted(CLOSED_INDEX_KINDS.filter((kind) => !(FEEDBACK_ACTIVITY_KINDS as readonly string[]).includes(kind))),
    );
    expect(requested[0]).toEqual(expect.arrayContaining(["held_reply_released", "delivery_failure_cleared"]));
  });

  it("presents a released held reply as a closed approval, and a cleared delivery failure as its own item", async () => {
    const { service } = readServiceOver([
      closingRecord("held_reply_released"),
      closingRecord("delivery_failure_cleared"),
    ]);

    const items = await service.listRecentlyClosed(WORKSPACE_ID, 20, { includeFeedback: false });

    expect(items.map(({ outcome, itemKind }) => ({ outcome, itemKind }))).toEqual([
      { outcome: "held_reply_released", itemKind: "approval" },
      { outcome: "delivery_failure_cleared", itemKind: "delivery_failed" },
    ]);
    for (const item of items) {
      expect(item).toMatchObject({
        conversationId: CONVERSATION_ID,
        closedBy: { userId: ACTOR_ID, label: "Ada" },
        decision: null,
        resolution: null,
        preview: "Where is my order?",
      });
    }
  });
});
