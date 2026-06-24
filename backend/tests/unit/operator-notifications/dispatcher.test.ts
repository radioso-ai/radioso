import { describe, expect, it, vi } from "vitest";

import {
  OperatorNotificationDispatcher,
  type OperatorNotification,
  type OperatorNotificationContext,
  type OperatorNotificationSink,
} from "../../../src/modules/operatorNotifications/public.js";

const notification: OperatorNotification = {
  kind: "approval",
  workspaceId: "ws_1",
  conversationId: "conv_1",
  agentId: "agent_1",
  handle: "pd_1",
  dashboardPath: "/conversations/conv_1",
};

const context: OperatorNotificationContext = {
  requestId: "request_1",
  workspaceId: "ws_1",
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:approval.request",
};

describe("OperatorNotificationDispatcher", () => {
  it("fans out to every sink", async () => {
    const first: OperatorNotificationSink = { deliver: vi.fn(async () => {}) };
    const second: OperatorNotificationSink = { deliver: vi.fn(async () => {}) };
    const dispatcher = new OperatorNotificationDispatcher([first, second]);

    await dispatcher.dispatch(notification, context);

    expect(first.deliver).toHaveBeenCalledWith(notification, context);
    expect(second.deliver).toHaveBeenCalledWith(notification, context);
  });

  it("attempts every sink even when one fails, then rethrows so the action outbox retries", async () => {
    const warn = vi.fn();
    const failing: OperatorNotificationSink = {
      deliver: vi.fn(async () => {
        throw new Error("sink_down");
      }),
    };
    const succeeding: OperatorNotificationSink = { deliver: vi.fn(async () => {}) };
    const dispatcher = new OperatorNotificationDispatcher([failing, succeeding], { warn });

    // The other sink is still attempted (no short-circuit), but the failure is surfaced so the
    // at-least-once outbox retries — idempotent sinks de-dupe the already-delivered ones.
    await expect(dispatcher.dispatch(notification, context)).rejects.toThrow();

    expect(succeeding.deliver).toHaveBeenCalledWith(notification, context);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "operator_notification_sink_failed",
        kind: "approval",
        workspaceId: "ws_1",
      }),
      "Operator notification sink failed",
    );
  });
});
