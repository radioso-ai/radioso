import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AccountPermission } from "../../../src/modules/account/public.js";
import { resolveReadableEventTypes, WorkspaceEventLog } from "../../../src/modules/workspaceEventLog/public.js";
import { encodeCursor } from "../../../src/shared/domain/cursorPagination.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import { WORKSPACE_EVENT_TYPES } from "../../../src/shared/domain/workspaceEventLog.js";
import { InMemoryWorkspaceEventLogStore } from "../../support/inMemoryWorkspaceEventLog.js";

const WORKSPACE = randomUUID();
const ALL_TYPES = [...WORKSPACE_EVENT_TYPES];

const harness = (now = new Date("2026-11-19T10:00:00.000Z")) => {
  const store = new InMemoryWorkspaceEventLogStore();
  let clock = now;
  const expired: string[] = [];
  const metrics = { incrementCounter: (name: string) => { expired.push(name); } };
  const log = new WorkspaceEventLog({ store, metrics, clock: () => clock });
  const list = (input: { after?: string | null; types?: typeof ALL_TYPES | null; readable?: typeof ALL_TYPES; limit?: number } = {}) =>
    log.list({
      workspaceId: WORKSPACE,
      readableTypes: input.readable ?? ALL_TYPES,
      requestedTypes: input.types ?? null,
      after: input.after ?? null,
      limit: input.limit ?? 50,
    });
  return { store, list, expired, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
};

const refusal = async (promise: Promise<unknown>): Promise<{ statusCode: number; code: string }> => {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(AppError);
  return { statusCode: (error as AppError).statusCode, code: (error as AppError).code };
};

describe("workspace event log", () => {
  it("starts a client at the newest events, oldest first, then pages forward from there", async () => {
    const h = harness();
    const first = h.store.append({ workspaceId: WORKSPACE, type: "conversation.started" });
    const second = h.store.append({ workspaceId: WORKSPACE, type: "routine.completed", data: { routineId: "booking" } });
    h.store.append({ workspaceId: randomUUID(), type: "conversation.started" });

    const start = await h.list({ limit: 10 });
    expect(start.events.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(start.events[1]).toMatchObject({
      type: "routine.completed",
      version: 1,
      workspaceId: WORKSPACE,
      data: { conversationId: second.conversationId, channel: "web", callerKind: "human", routineId: "booking" },
    });
    expect(start.hasMore).toBe(false);

    const quiet = await h.list({ after: start.nextCursor });
    expect(quiet.events).toEqual([]);

    const third = h.store.append({ workspaceId: WORKSPACE, type: "handoff.requested", data: { reason: "routine_handoff" } });
    const next = await h.list({ after: quiet.nextCursor });
    expect(next.events.map((event) => event.id)).toEqual([third.id]);
  });

  it("never passes an event whose transaction commits after a later-numbered one", async () => {
    const h = harness();
    const start = await h.list();

    // The earlier transaction writes first, so its event takes the smaller position, and commits last.
    const slow = h.store.begin();
    const late = h.store.append({ workspaceId: WORKSPACE, type: "contact_request.created", tx: slow });
    const early = h.store.append({ workspaceId: WORKSPACE, type: "conversation.started" });

    const whileRunning = await h.list({ after: start.nextCursor });
    expect(whileRunning.events).toEqual([]);

    h.store.commit(slow);
    const afterCommit = await h.list({ after: whileRunning.nextCursor });
    expect(afterCommit.events.map((event) => event.id)).toEqual([late.id, early.id]);
  });

  it("pages a full log in order with a cursor at each page's last event", async () => {
    const h = harness();
    const start = await h.list();
    const appended = Array.from({ length: 5 }, () => h.store.append({ workspaceId: WORKSPACE, type: "conversation.started" }));

    const first = await h.list({ after: start.nextCursor, limit: 2 });
    const second = await h.list({ after: first.nextCursor, limit: 2 });
    const third = await h.list({ after: second.nextCursor, limit: 2 });

    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    expect([...first.events, ...second.events, ...third.events].map((event) => event.id)).toEqual(appended.map((event) => event.id));
  });

  it("serves only the requested types, and refuses a type the caller may not read", async () => {
    const h = harness();
    h.store.append({ workspaceId: WORKSPACE, type: "conversation.started" });
    const decision = h.store.append({ workspaceId: WORKSPACE, type: "decision.pending" });

    const decisions = await h.list({ types: ["decision.pending"] });
    expect(decisions.events.map((event) => event.id)).toEqual([decision.id]);

    const readable = ALL_TYPES.filter((type) => type !== "decision.pending");
    const unfiltered = await h.list({ readable });
    expect(unfiltered.events.map((event) => event.type)).toEqual(["conversation.started"]);
    expect(await refusal(h.list({ readable, types: ["decision.pending"] }))).toEqual({ statusCode: 403, code: "event_type_not_permitted" });
  });

  it("refuses a cursor issued for other types, a cursor it never issued, and one past the retention window", async () => {
    const h = harness();
    const routines = await h.list({ types: ["routine.completed"] });

    expect(await refusal(h.list({ after: routines.nextCursor, types: ["contact_request.created"] })))
      .toEqual({ statusCode: 400, code: "cursor_filter_mismatch" });
    expect(await refusal(h.list({ after: "not-a-cursor" }))).toEqual({ statusCode: 400, code: "invalid_cursor" });

    h.advance(30 * 24 * 60 * 60 * 1_000);
    expect(await refusal(h.list({ after: routines.nextCursor, types: ["routine.completed"] })))
      .toEqual({ statusCode: 410, code: "cursor_expired" });
    expect(h.expired).toEqual(["workspace_events_cursor_expired_total"]);
  });

  it("ages a full page's cursor from its last event, so a cursor deep in old events expires on time", async () => {
    const day = 24 * 60 * 60 * 1_000;
    const h = harness();
    const start = await h.list();
    h.store.append({ workspaceId: WORKSPACE, type: "conversation.started", occurredAt: new Date(Date.parse("2026-11-19T10:00:00.000Z") - 20 * day) });
    h.store.append({ workspaceId: WORKSPACE, type: "conversation.started" });

    const page = await h.list({ after: start.nextCursor, limit: 1 });
    expect(page.hasMore).toBe(true);

    // The cursor names an event 20 days old: ten days on, the event behind it may be gone.
    h.advance(10 * day);
    expect(await refusal(h.list({ after: page.nextCursor }))).toEqual({ statusCode: 410, code: "cursor_expired" });
  });

  it("refuses a cursor whose place lies outside the log's number ranges as invalid, before it reaches the store", async () => {
    const h = harness();
    const at = new Date("2026-11-19T10:00:00.000Z").toISOString();
    const outOfRange = [
      encodeCursor({ tx: "18446744073709551616", pos: "1", filter: "*", at }),
      encodeCursor({ tx: "1", pos: "9223372036854775808", filter: "*", at }),
      encodeCursor({ tx: "-1", pos: "1", filter: "*", at }),
    ];

    for (const cursor of outOfRange) {
      expect(await refusal(h.list({ after: cursor }))).toEqual({ statusCode: 400, code: "invalid_cursor" });
    }
  });
});

describe("readable event types", () => {
  const holding = (...held: AccountPermission[]) => async (permission: AccountPermission) => held.includes(permission);

  it("gives conversation events to a history reader, and a pending decision only with takeover too", async () => {
    expect(await resolveReadableEventTypes(holding("workspace.history.read"))).toEqual([
      "conversation.started",
      "contact_request.created",
      "handoff.requested",
      "routine.completed",
    ]);
    expect(await resolveReadableEventTypes(holding("workspace.history.read", "workspace.conversation.takeover"))).toEqual(ALL_TYPES);
    expect(await resolveReadableEventTypes(holding("workspace.conversation.takeover"))).toEqual([]);
  });
});
