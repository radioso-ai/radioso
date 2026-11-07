import { describe, expect, it, vi } from "vitest";

import {
  NotificationDeliveryLog,
  NotificationDeliveryReader,
  type NotificationDeliveryRecord,
  type NotificationDeliveryStore,
} from "../../../src/modules/operatorNotifications/notificationDeliveryLog.js";
import type { RecipientDelivery } from "../../../src/modules/operatorNotifications/notificationDelivery.js";
import type { UndeliveredRecipientAlertPort } from "../../../src/modules/operatorNotifications/undeliveredRecipientAlert.js";

const WORKSPACE = "00000000-0000-4000-8000-0000000000aa";
const CONVERSATION = "00000000-0000-4000-8000-0000000000bb";
const AGENT = "00000000-0000-4000-8000-0000000000cc";

const subject = (overrides: Partial<Parameters<NotificationDeliveryLog["record"]>[0]> = {}) => ({
  workspaceId: WORKSPACE,
  agentId: AGENT as string | null,
  conversationId: CONVERSATION as string | null,
  requestId: "00000000-0000-4000-8000-000000000001",
  kind: "handoff" as const,
  ...overrides,
});

const setup = (options: { upsert?: NotificationDeliveryStore["upsert"] } = {}) => {
  const upsert = vi.fn(options.upsert ?? (async () => undefined));
  const notify = vi.fn(async (_input: Parameters<UndeliveredRecipientAlertPort["notify"]>[0]) => undefined);
  const alerts: UndeliveredRecipientAlertPort = { notify };
  const logger = { warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const log = new NotificationDeliveryLog({ store: { upsert }, alerts, logger, metrics });
  return { log, upsert, notify, logger, metrics };
};

describe("NotificationDeliveryLog", () => {
  it("writes the notice's addresses against its conversation", async () => {
    const { log, upsert } = setup();
    const deliveries: RecipientDelivery[] = [{ email: "a@example.com", outcome: "sent" }];

    await log.record(subject(), deliveries);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, conversationId: CONVERSATION, agentId: AGENT, kind: "handoff" }),
      deliveries,
    );
  });

  it("records nothing for a notice with no conversation or no address", async () => {
    const { log, upsert, notify } = setup();

    await log.record(subject({ conversationId: null }), [{ email: "a@example.com", outcome: "skipped_unconfirmed" }]);
    await log.record(subject(), []);

    expect(upsert).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("treats an agent id that is not an id as no agent, leaving the conversation's to decide", async () => {
    const { log, upsert } = setup();

    await log.record(subject({ agentId: "unknown" }), [{ email: "a@example.com", outcome: "sent" }]);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ agentId: null }), expect.anything());
  });

  it("warns administrators about unconfirmed, stopped and bounced addresses, and about nothing else", async () => {
    const { log, notify } = setup();

    await log.record(subject(), [
      { email: "waiting@example.com", outcome: "skipped_unconfirmed" },
      { email: "stopped@example.com", outcome: "skipped_revoked" },
      { email: "bounced@example.com", outcome: "skipped_suppressed" },
      { email: "capped@example.com", outcome: "skipped_cap" },
      { email: "broken@example.com", outcome: "failed" },
      { email: "logged@example.com", outcome: "not_dispatched" },
      { email: "fine@example.com", outcome: "sent" },
    ]);

    expect(notify.mock.calls.map(([call]) => [call.email, call.reason])).toEqual([
      ["waiting@example.com", "unconfirmed"],
      ["stopped@example.com", "revoked"],
      ["bounced@example.com", "suppressed"],
    ]);
  });

  it("never rejects when the record cannot be written, and still warns administrators", async () => {
    const { log, notify, logger, metrics } = setup({
      upsert: async () => { throw new Error("connection refused for waiting@example.com"); },
    });

    await expect(log.record(subject(), [{ email: "waiting@example.com", outcome: "skipped_unconfirmed" }])).resolves.toBeUndefined();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "notification_delivery_record_failed", workspaceId: WORKSPACE }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("waiting@example.com");
    expect(metrics.incrementCounter).toHaveBeenCalledWith("notification_delivery_record_failures_total", expect.anything());
  });

  it("never rejects when an alert fails", async () => {
    const { log, notify, logger } = setup();
    notify.mockRejectedValue(new Error("mail provider down"));

    await expect(log.record(subject(), [{ email: "waiting@example.com", outcome: "skipped_unconfirmed" }])).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "notification_undelivered_alert_failed" }),
      expect.any(String),
    );
  });

  it("counts recorded outcomes without naming an address", async () => {
    const { log, metrics } = setup();

    await log.record(subject(), [
      { email: "a@example.com", outcome: "sent" },
      { email: "b@example.com", outcome: "sent" },
      { email: "c@example.com", outcome: "skipped_cap" },
    ]);

    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "notification_deliveries_recorded_total",
      expect.objectContaining({ labels: { outcome: "sent" }, value: 2 }),
    );
    expect(JSON.stringify(metrics.incrementCounter.mock.calls)).not.toContain("example.com");
  });
});

const record = (n: number): NotificationDeliveryRecord => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  agentId: AGENT,
  conversationId: CONVERSATION,
  kind: "contact_request",
  recipientEmail: `r${n}@example.com`,
  outcome: "sent",
  createdAt: new Date(Date.UTC(2026, 10, 7, 12, 0, 60 - n)),
  updatedAt: new Date(Date.UTC(2026, 10, 7, 12, 0, 60 - n)),
});

describe("NotificationDeliveryReader", () => {
  it("returns a page and a cursor that continues after it", async () => {
    const all = [1, 2, 3].map(record);
    const list = vi.fn(async (_workspaceId: string, query: { after: { createdAt: Date; id: string } | null; limit: number }) => {
      const start = query.after ? all.findIndex((row) => row.id === query.after!.id) + 1 : 0;
      return all.slice(start, start + query.limit);
    });
    const reader = new NotificationDeliveryReader({ list });

    const first = await reader.list(WORKSPACE, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([all[0].id, all[1].id]);
    expect(first.nextCursor).not.toBeNull();

    const second = await reader.list(WORKSPACE, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual([all[2].id]);
    expect(second.nextCursor).toBeNull();
    // One row past the page is asked for, to know whether another follows.
    expect(list).toHaveBeenNthCalledWith(1, WORKSPACE, expect.objectContaining({ limit: 3, after: null }));
  });

  it("passes the agent and outcome filters to the store", async () => {
    const list = vi.fn(async () => []);

    await new NotificationDeliveryReader({ list }).list(WORKSPACE, { limit: 10, agentId: AGENT, outcome: "skipped_unconfirmed" });

    expect(list).toHaveBeenCalledWith(WORKSPACE, expect.objectContaining({ agentId: AGENT, outcome: "skipped_unconfirmed" }));
  });

  it("rejects a cursor that is not one of its own", async () => {
    const reader = new NotificationDeliveryReader({ list: async () => [] });

    await expect(reader.list(WORKSPACE, { limit: 10, cursor: "not-a-cursor" })).rejects.toMatchObject({ statusCode: 400 });
  });
});
