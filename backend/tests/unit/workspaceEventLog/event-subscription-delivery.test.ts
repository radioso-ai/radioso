import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { deliveryBackoffMs, failedDeliveryStreak } from "../../../src/modules/workspaceEventLog/deliveryPolicy.js";
import { EventDeliveryTargetRefusedError, WorkspaceEventDeliveryDrain } from "../../../src/modules/workspaceEventLog/public.js";
import { WebhookResponseStatusError } from "../../../src/shared/infra/http/signedWebhook.js";
import { InMemoryWorkspaceEventLogStore } from "../../support/inMemoryWorkspaceEventLog.js";
import { InMemoryWorkspaceEventSubscriptionStore, taggingSealer } from "../../support/inMemoryWorkspaceEventSubscriptions.js";

const SECOND = 1_000;
const HOUR = 3_600 * SECOND;

describe("event subscription delivery policy", () => {
  it("backs off 30 s, doubling per consecutive failure, up to an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 20].map(deliveryBackoffMs)).toEqual([
      30 * SECOND, 60 * SECOND, 120 * SECOND, 240 * SECOND, 480 * SECOND, 960 * SECOND, 1_920 * SECOND, HOUR, HOUR, HOUR,
    ]);
  });

  it("disables only after a day of failures and at least five attempts", () => {
    const at = new Date("2026-11-19T12:00:00.000Z");
    const dayAgo = new Date(at.getTime() - 24 * HOUR);
    expect(failedDeliveryStreak({ previousFailures: 0, failingSince: null, at })).toEqual({
      consecutiveFailures: 1, failingSince: at, nextAttemptAt: new Date(at.getTime() + 30 * SECOND), disable: false,
    });
    // A day of failing, but only three tries so far: keep trying.
    expect(failedDeliveryStreak({ previousFailures: 2, failingSince: dayAgo, at }).disable).toBe(false);
    // Five tries, but not a day yet.
    expect(failedDeliveryStreak({ previousFailures: 9, failingSince: new Date(at.getTime() - 23 * HOUR), at }).disable).toBe(false);
    expect(failedDeliveryStreak({ previousFailures: 4, failingSince: dayAgo, at })).toMatchObject({ consecutiveFailures: 5, failingSince: dayAgo, disable: true });
  });
});

describe("event subscription drain", () => {
  const harness = (options: { post?: (url: string) => Promise<{ status: number }>; permits?: boolean } = {}) => {
    const workspaceId = randomUUID();
    const log = new InMemoryWorkspaceEventLogStore();
    const subscriptions = new InMemoryWorkspaceEventSubscriptionStore();
    const posts: Array<{ url: string; headers: Record<string, string>; rawBody: string }> = [];
    const logger = { warn: vi.fn(), info: vi.fn() };
    const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
    const requeue = vi.fn(async () => undefined);
    const drain = new WorkspaceEventDeliveryDrain({
      subscriptions,
      log,
      owners: { permits: vi.fn(async () => options.permits ?? true) },
      client: {
        post: async (request) => {
          posts.push(request);
          return options.post ? options.post(request.url) : { status: 204 };
        },
      },
      sealer: taggingSealer,
      requeue,
      audit: { record: vi.fn(async () => undefined) },
      metrics,
      logger,
    });
    const subscribe = async () => {
      const created = await subscriptions.createWithinCap({
        workspaceId,
        label: "n8n",
        targetHost: "hooks.example",
        targetUrlCiphertext: taggingSealer.seal("https://hooks.example/a-secret-path"),
        secretCiphertext: taggingSealer.seal("whsec"),
        eventTypes: ["handoff.requested"],
        createdBy: { kind: "teammate", userId: randomUUID() },
        cap: 25,
      });
      return { workspaceId, subscriptionId: created!.id };
    };
    return { workspaceId, log, subscriptions, posts, logger, metrics, requeue, drain, subscribe };
  };

  it("counts each outcome and never logs the target URL or a body", async () => {
    const h = harness({ post: async () => { throw new WebhookResponseStatusError(503); } });
    const target = await h.subscribe();
    h.log.append({ workspaceId: h.workspaceId, type: "handoff.requested", data: { reason: "routine_handoff" } });

    await expect(h.drain.drain(target)).resolves.toEqual({ delivered: 0, stoppedBy: "failing" });

    expect(h.metrics.incrementCounter).toHaveBeenCalledWith("workspace_event_deliveries_total", expect.objectContaining({ labels: { outcome: "failed" } }));
    const logged = JSON.stringify([...h.logger.warn.mock.calls, ...h.logger.info.mock.calls]);
    expect(logged).not.toContain("hooks.example/a-secret-path");
    expect(logged).not.toContain("routine_handoff");
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("labels a refused target as blocked, and warns only on the first failure of a streak", async () => {
    const h = harness({ post: async () => { throw new EventDeliveryTargetRefusedError(); } });
    const target = await h.subscribe();
    h.log.append({ workspaceId: h.workspaceId, type: "handoff.requested", data: { reason: "routine_handoff" } });

    await h.drain.drain(target);
    const row = h.subscriptions.rows.get(target.subscriptionId)!;
    row.nextAttemptAt = new Date(Date.now() - SECOND);
    await h.drain.drain(target);

    expect(h.metrics.incrementCounter).toHaveBeenCalledWith("workspace_event_deliveries_total", expect.objectContaining({ labels: { outcome: "blocked" } }));
    expect(row.consecutiveFailures).toBe(2);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("hands a backlog longer than one run's budget to its next run", async () => {
    const h = harness();
    const target = await h.subscribe();
    for (let index = 0; index < 3; index += 1) {
      h.log.append({ workspaceId: h.workspaceId, type: "handoff.requested", data: { reason: "routine_handoff" } });
    }
    const budgeted = new WorkspaceEventDeliveryDrain({
      subscriptions: h.subscriptions,
      log: h.log,
      owners: { permits: async () => true },
      client: { post: async () => ({ status: 200 }) },
      sealer: taggingSealer,
      requeue: h.requeue,
      audit: { record: async () => undefined },
      metrics: null,
      logger: h.logger,
      budgetMs: 0,
    });

    await expect(budgeted.drain(target)).resolves.toEqual({ delivered: 1, stoppedBy: "budget" });
    expect(h.requeue).toHaveBeenCalledWith(target);
  });

  it("sends nothing for an event type the subscription did not ask for", async () => {
    const h = harness();
    const target = await h.subscribe();
    h.log.append({ workspaceId: h.workspaceId, type: "conversation.started" });

    await expect(h.drain.drain(target)).resolves.toEqual({ delivered: 0, stoppedBy: "caught_up" });
    expect(h.posts).toEqual([]);
  });
});
