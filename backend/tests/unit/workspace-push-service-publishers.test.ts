import { describe, expect, it, vi } from "vitest";

import { DocumentSearchService } from "../../src/modules/documents/services/documentSearchService.js";
import { AnswerFeedbackService } from "../../src/modules/chat/services/answerFeedbackService.js";
import { InMemoryWorkspaceEventBus } from "../../src/shared/events/workspaceEventBus.js";

describe("workspace push service publishers", () => {
  it("publishes quality.feedback_changed for feedback writes", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const query = {} as Record<string, (...args: never[]) => unknown>;
    for (const method of ["innerJoin", "select", "where", "limit", "values", "returning"]) {
      query[method] = vi.fn(() => query);
    }
    query.executeTakeFirst = vi.fn(async () => ({ conversation_id: "conversation-1" }));
    query.executeTakeFirstOrThrow = vi.fn(async () => ({
      id: "feedback-1",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      assistant_message_id: "message-1",
      account_id: "account-1",
      user_id: "user-1",
      anonymous_session_id: null,
      actor_type: "authenticated_user",
      actor_id: "user-1",
      value: "down",
      comment: "Needs work",
      created_at: new Date("2026-08-21T10:00:00.000Z"),
      updated_at: new Date("2026-08-21T10:00:00.000Z"),
    }));
    query.onConflict = vi.fn((...args: never[]) => {
      const callback = args[0] as (input: unknown) => unknown;
      callback({ columns: () => ({ doUpdateSet: () => query }) });
      return query;
    });
    const db = {
      selectFrom: vi.fn(() => query),
      insertInto: vi.fn(() => query),
    };
    const service = new AnswerFeedbackService(db as never, bus);

    await service.upsert({
      workspaceId: "workspace-1",
      assistantMessageId: "message-1",
      value: "down",
      actor: { type: "authenticated_user", id: "user-1", accountId: "account-1", userId: "user-1" },
    });

    await expect(events.next()).resolves.toMatchObject({
      value: {
        resourceType: "quality",
        resourceId: "message-1",
        workspaceId: "workspace-1",
        changeKind: "quality.feedback_changed",
      },
    });
    await events.return?.();
  });

  it("publishes search.created beside the document.search audit write", async () => {
    const bus = new InMemoryWorkspaceEventBus();
    const events = bus.subscribe("workspace-1")[Symbol.asyncIterator]();
    const service = new DocumentSearchService(
      { listSummariesByIdsAndWorkspaceId: vi.fn().mockResolvedValue([]) } as never,
      { run: vi.fn().mockResolvedValue({ contexts: [], trace: [] }) } as never,
      { record: vi.fn().mockResolvedValue(undefined) } as never,
      bus,
    );

    const response = await service.search({ workspaceId: "workspace-1", query: "pricing" });

    await expect(events.next()).resolves.toMatchObject({
      value: {
        resourceType: "search",
        resourceId: response.searchId,
        workspaceId: "workspace-1",
        changeKind: "search.created",
      },
    });
    await events.return?.();
  });
});
