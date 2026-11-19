import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { deliveryBackoffMs, scheduleAfterFailure } from "../../../src/modules/workspaceEventLog/deliveryPolicy.js";
import { WorkspaceEventDeliveryDrain } from "../../../src/modules/workspaceEventLog/public.js";
import { PublicHostUnresolvedError, PublicNetworkPolicyError } from "../../../src/shared/domain/publicNetwork.js";
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
    expect(scheduleAfterFailure({ consecutiveFailures: 1, failingSince: at }, at)).toEqual({
      nextAttemptAt: new Date(at.getTime() + 30 * SECOND), disable: false,
    });
    // A day of failing, but only three tries so far: keep trying.
    expect(scheduleAfterFailure({ consecutiveFailures: 3, failingSince: dayAgo }, at).disable).toBe(false);
    // Ten tries, but not a day yet.
    expect(scheduleAfterFailure({ consecutiveFailures: 10, failingSince: new Date(at.getTime() - 23 * HOUR) }, at).disable).toBe(false);
    expect(scheduleAfterFailure({ consecutiveFailures: 5, failingSince: dayAgo }, at).disable).toBe(true);
  });
});

describe("event subscription drain", () => {
  type Send = (request: { url: string; signal?: AbortSignal }) => Promise<{ status: number }>;

  const harness = (options: { send?: Send; permits?: boolean; budgetMs?: number } = {}) => {
    const workspaceId = randomUUID();
    const log = new InMemoryWorkspaceEventLogStore();
    const subscriptions = new InMemoryWorkspaceEventSubscriptionStore();
    const sends: Array<{ url: string; rawBody: string; signal?: AbortSignal }> = [];
    const logger = { warn: vi.fn(), info: vi.fn() };
    const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
    const audit = { record: vi.fn(async () => undefined) };
    const requeue = vi.fn(async () => undefined);
    const drainWith = (sealer = taggingSealer) => new WorkspaceEventDeliveryDrain({
      subscriptions,
      log,
      owners: { permits: vi.fn(async () => options.permits ?? true) },
      client: {
        send: async (request) => {
          sends.push(request);
          return options.send ? options.send(request) : { status: 204 };
        },
      },
      sealer,
      requeue,
      audit,
      metrics,
      logger,
      ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    });
    const subscribe = async () => {
      const created = await subscriptions.upsertWithinCap({
        workspaceId,
        label: "n8n",
        targetHost: "hooks.example",
        targetUrlCiphertext: taggingSealer.seal("https://hooks.example/a-secret-path"),
        targetUrlHashes: ["a".repeat(64)],
        secretCiphertext: taggingSealer.seal("whsec"),
        eventTypes: ["handoff.requested"],
        createdBy: { kind: "teammate", userId: randomUUID() },
        cap: 25,
      });
      return { workspaceId, subscriptionId: created!.subscription.id };
    };
    const handoff = () => log.append({ workspaceId, type: "handoff.requested", data: { reason: "routine_handoff" } });
    const outcomes = () => metrics.incrementCounter.mock.calls.map(([, call]) => (call as { labels: { outcome: string } }).labels.outcome);
    return { workspaceId, log, subscriptions, sends, logger, metrics, audit, requeue, drain: drainWith(), drainWith, subscribe, handoff, outcomes };
  };

  it("counts each outcome and never logs the target URL or a body", async () => {
    const h = harness({ send: async () => { throw new WebhookResponseStatusError(503); } });
    const target = await h.subscribe();
    h.handoff();

    await expect(h.drain.drain(target)).resolves.toEqual({ delivered: 0, stoppedBy: "failing" });

    expect(h.outcomes()).toEqual(["failed"]);
    const logged = JSON.stringify([...h.logger.warn.mock.calls, ...h.logger.info.mock.calls]);
    expect(logged).not.toContain("hooks.example/a-secret-path");
    expect(logged).not.toContain("routine_handoff");
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("labels the outbound URL guard's refusal blocked, and a host that does not resolve failed", async () => {
    const refused = harness({ send: async () => { throw new TypeError("fetch failed", { cause: new PublicNetworkPolicyError() }); } });
    await refused.drain.drain((refused.handoff(), await refused.subscribe()));
    const unresolved = harness({ send: async () => { throw new TypeError("fetch failed", { cause: new PublicHostUnresolvedError() }); } });
    await unresolved.drain.drain((unresolved.handoff(), await unresolved.subscribe()));

    expect(refused.outcomes()).toEqual(["blocked"]);
    expect(unresolved.outcomes()).toEqual(["failed"]);
    expect(unresolved.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorClass: "PublicHostUnresolvedError" }), expect.any(String));
  });

  it("warns only on the first failure of a streak", async () => {
    const h = harness({ send: async () => { throw new WebhookResponseStatusError(500); } });
    const target = await h.subscribe();
    h.handoff();

    await h.drain.drain(target);
    h.subscriptions.rows.get(target.subscriptionId)!.nextAttemptAt = new Date(Date.now() - SECOND);
    await h.drain.drain(target);

    expect(h.subscriptions.rows.get(target.subscriptionId)!.consecutiveFailures).toBe(2);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("posts at most ten events a run and hands the rest to its next run", async () => {
    const h = harness();
    const target = await h.subscribe();
    for (let index = 0; index < 12; index += 1) h.handoff();

    await expect(h.drain.drain(target)).resolves.toEqual({ delivered: 10, stoppedBy: "more_waiting" });
    expect(h.requeue).toHaveBeenCalledWith(target);
    await expect(h.drain.drain(target)).resolves.toEqual({ delivered: 2, stoppedBy: "caught_up" });
    expect(h.sends).toHaveLength(12);
  });

  it("stops past its time budget and hands the rest to its next run", async () => {
    const h = harness({ budgetMs: 0 });
    const target = await h.subscribe();
    for (let index = 0; index < 3; index += 1) h.handoff();

    await expect(h.drain.drain(target)).resolves.toEqual({ delivered: 1, stoppedBy: "more_waiting" });
    expect(h.requeue).toHaveBeenCalledWith(target);
  });

  it("moves a quiet subscription's cursor to the horizon, past events of types it did not ask for", async () => {
    const h = harness();
    const target = await h.subscribe();
    h.log.append({ workspaceId: h.workspaceId, type: "conversation.started" });
    h.log.append({ workspaceId: h.workspaceId, type: "conversation.started" });

    await expect(h.drain.drain(target)).resolves.toEqual({ delivered: 0, stoppedBy: "caught_up" });

    expect(h.sends).toEqual([]);
    const horizon = (await h.log.readPage({ workspaceId: h.workspaceId, types: ["handoff.requested"], after: { tx: "0", position: "0" }, limit: 1 })).horizon;
    expect(h.subscriptions.rows.get(target.subscriptionId)!.cursor).toEqual({ tx: horizon, position: "0" });
  });

  it("stops without a disabled audit when the subscription is deleted while a push runs", async () => {
    const h = harness({
      send: async () => {
        h.subscriptions.rows.clear();
        return { status: 200 };
      },
    });
    const target = await h.subscribe();
    h.handoff();
    h.handoff();

    await expect(h.drain.drain(target)).resolves.toEqual({ delivered: 0, stoppedBy: "missing" });
    expect(h.sends).toHaveLength(1);
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it("stops when the subscription is deleted while a failing push runs, recording nothing", async () => {
    const h = harness({
      send: async () => {
        h.subscriptions.rows.clear();
        throw new WebhookResponseStatusError(500);
      },
    });
    const target = await h.subscribe();
    h.handoff();

    await expect(h.drain.drain(target)).resolves.toEqual({ delivered: 0, stoppedBy: "missing" });
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("ends quietly, logging why, when the target cannot be opened under the configured key", async () => {
    const h = harness();
    const target = await h.subscribe();
    h.handoff();
    const unreadable = h.drainWith({ ...taggingSealer, open: () => { throw new Error("no key opens it"); } });

    await expect(unreadable.drain(target)).resolves.toEqual({ delivered: 0, stoppedBy: "unreadable" });
    expect(h.sends).toEqual([]);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it("hands the run's abort signal to every push", async () => {
    const h = harness();
    const target = await h.subscribe();
    h.handoff();
    const run = new AbortController();

    await h.drain.drain(target, run.signal);

    expect(h.sends[0]?.signal).toBe(run.signal);
  });
});
