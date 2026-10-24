import { describe, expect, it, vi } from "vitest";

import { conversationRetentionPeriodicTask } from "../../src/app/composition/conversationRetention.js";
import {
  ConversationRetentionSweep,
  type InactiveConversationBatch,
  type WorkspaceConversationRetention,
} from "../../src/modules/privacy/public.js";
import type { ConversationDataRetentionRule } from "../../src/shared/domain/conversationDataRetention.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * An erasure over an in-memory backlog of expired conversations per workspace. `revived` are
 * conversations a claim takes and the recheck under their locks then drops, because a message
 * reached them after the claim's snapshot.
 */
const createErasure = (backlog: Record<string, number>, options: { failFor?: string; revived?: Record<string, number> } = {}) => {
  const calls: InactiveConversationBatch[] = [];
  const revived = { ...options.revived };
  return {
    calls,
    erasure: {
      eraseInactiveConversations: vi.fn(async (input: InactiveConversationBatch) => {
        calls.push(input);
        if (input.workspaceId === options.failFor) throw new TypeError("deadlock");
        const dropped = Math.min(revived[input.workspaceId] ?? 0, input.limit);
        revived[input.workspaceId] = (revived[input.workspaceId] ?? 0) - dropped;
        const erased = Math.min(backlog[input.workspaceId] ?? 0, input.limit - dropped);
        backlog[input.workspaceId] = (backlog[input.workspaceId] ?? 0) - erased;
        return { conversationCount: erased, messageCount: erased * 3, rowsByOwner: { audit: erased }, claimedCount: dropped + erased };
      }),
    },
  };
};

/** Policies that order workspaces least recently swept first, as the Postgres store does. */
const createPolicies = (policies: WorkspaceConversationRetention[]) => {
  const sweptAt = new Map<string, number>();
  return {
    sweptAt,
    listConversationRetention: async () => [...policies].sort((left, right) =>
      (sweptAt.get(left.workspaceId) ?? -1) - (sweptAt.get(right.workspaceId) ?? -1)
      || left.workspaceId.localeCompare(right.workspaceId)),
    recordSwept: vi.fn(async (workspaceIds: readonly string[], at: Date) => {
      for (const workspaceId of workspaceIds) sweptAt.set(workspaceId, at.getTime());
    }),
  };
};

const rule = (
  table: string,
  backlog: { rows: number },
  options: { fails?: boolean; onRunComplete?: (input: { now: Date; totalRemoved: number }) => Promise<void> } = {},
): ConversationDataRetentionRule => ({
  table,
  enforce: vi.fn(async ({ limit }) => {
    if (options.fails) throw new RangeError("statement timeout");
    const removed = Math.min(backlog.rows, limit);
    backlog.rows -= removed;
    return removed;
  }),
  ...(options.onRunComplete ? { onRunComplete: vi.fn(options.onRunComplete) } : {}),
});

const policy = (workspaceId: string, retentionDays = 30): WorkspaceConversationRetention => ({
  workspaceId,
  accountId: `account-${workspaceId}`,
  retentionDays,
});

const createSweep = (input: {
  policies: WorkspaceConversationRetention[] | ReturnType<typeof createPolicies>;
  erasure: ReturnType<typeof createErasure>["erasure"];
  rules?: ConversationDataRetentionRule[];
  budget?: ConstructorParameters<typeof ConversationRetentionSweep>[0]["budget"];
  clock?: () => Date;
}) => {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const sweep = new ConversationRetentionSweep({
    policies: Array.isArray(input.policies) ? createPolicies(input.policies) : input.policies,
    erasure: input.erasure,
    rules: input.rules ?? [],
    clock: input.clock ?? (() => NOW),
    logger,
    metrics,
    ...(input.budget ? { budget: input.budget } : {}),
  });
  return { sweep, logger, metrics };
};

describe("ConversationRetentionSweep", () => {
  it("erases each workspace's conversations past its own window, through the erasure", async () => {
    const { erasure, calls } = createErasure({ "ws-a": 2, "ws-b": 1 });
    const { sweep } = createSweep({ policies: [policy("ws-a", 30), policy("ws-b", 365)], erasure });

    const result = await sweep.run();

    expect(calls.map(({ workspaceId, accountId, inactiveBefore, retentionDays }) => ({ workspaceId, accountId, inactiveBefore, retentionDays }))).toEqual([
      { workspaceId: "ws-a", accountId: "account-ws-a", inactiveBefore: new Date(NOW.getTime() - 30 * DAY_MS), retentionDays: 30 },
      { workspaceId: "ws-b", accountId: "account-ws-b", inactiveBefore: new Date(NOW.getTime() - 365 * DAY_MS), retentionDays: 365 },
    ]);
    expect(result).toEqual({
      removed: { conversations: 3, messages: 9 },
      erasedByOwner: { audit: 3 },
      failed: 0,
      drained: true,
    });
  });

  it("takes one batch per workspace per round, so a large backlog does not starve a small one", async () => {
    const { erasure, calls } = createErasure({ "ws-big": 100, "ws-small": 3 });
    const { sweep } = createSweep({
      policies: [policy("ws-big"), policy("ws-small")],
      erasure,
      budget: { conversationBatchSize: 2, maxConversationBatches: 5 },
    });

    const result = await sweep.run();

    expect(calls.map((call) => call.workspaceId)).toEqual(["ws-big", "ws-small", "ws-big", "ws-small", "ws-big"]);
    expect(result.removed.conversations).toBe(9);
    expect(result.drained).toBe(false);
  });

  it("sweeps every workspace with expired conversations within a bounded number of runs, however many opted in", async () => {
    const workspaceIds = Array.from({ length: 100 }, (_, index) => `ws-${String(index).padStart(3, "0")}`);
    const backlog = Object.fromEntries(workspaceIds.map((workspaceId) => [workspaceId, 3]));
    const { erasure } = createErasure(backlog);
    const policies = createPolicies(workspaceIds.map((workspaceId) => policy(workspaceId)));
    const budget = { conversationBatchSize: 5, maxConversationBatches: 10 };

    // Each run reaches ten workspaces with a backlog; the next starts with the ones it did not reach.
    for (let run = 0; run < 10; run += 1) {
      const result = await createSweep({ policies, erasure, budget, clock: () => new Date(NOW.getTime() + run * 60_000) }).sweep.run();
      expect(result.removed.conversations).toBe(30);
    }

    expect(Object.values(backlog).every((left) => left === 0)).toBe(true);
  });

  it("checks workspaces with nothing past their window without spending the erasure budget", async () => {
    const empty = Array.from({ length: 45 }, (_, index) => policy(`ws-empty-${String(index).padStart(2, "0")}`));
    const { erasure, calls } = createErasure({ "ws-z-backlog": 2 });
    const { sweep } = createSweep({ policies: [...empty, policy("ws-z-backlog")], erasure, budget: { maxConversationBatches: 40 } });

    const result = await sweep.run();

    expect(calls).toHaveLength(46);
    expect(result.removed.conversations).toBe(2);
    expect(result.drained).toBe(true);
  });

  it("caps the empty checks one run makes, and leaves the rest for the next run", async () => {
    const policies = createPolicies(Array.from({ length: 5 }, (_, index) => policy(`ws-${index}`)));
    const { erasure, calls } = createErasure({ "ws-4": 1 });

    const first = await createSweep({ policies, erasure, budget: { maxEmptyChecks: 3 } }).sweep.run();
    const second = await createSweep({ policies, erasure, budget: { maxEmptyChecks: 3 }, clock: () => new Date(NOW.getTime() + 60_000) }).sweep.run();

    expect(first.drained).toBe(false);
    expect(calls.slice(0, 3).map((call) => call.workspaceId)).toEqual(["ws-0", "ws-1", "ws-2"]);
    expect(calls.slice(3, 5).map((call) => call.workspaceId)).toEqual(["ws-3", "ws-4"]);
    expect(second.removed.conversations).toBe(1);
  });

  it("keeps giving a backlogged workspace batches across rounds, past more empty workspaces than the empty-check budget allows", async () => {
    const empties = Array.from({ length: 5 }, (_, index) => policy(`ws-b-empty-${index}`));
    const { erasure, calls } = createErasure({ "ws-a-backlog": 20 });
    const { sweep } = createSweep({
      policies: [policy("ws-a-backlog"), ...empties],
      erasure,
      budget: { conversationBatchSize: 2, maxConversationBatches: 4, maxEmptyChecks: 3 },
    });

    const result = await sweep.run();

    // The empty-check budget only bounds the first round, so later rounds keep serving the one
    // workspace a batch already found backlogged, up to the erasure-batch budget.
    expect(calls.filter((call) => call.workspaceId === "ws-a-backlog")).toHaveLength(4);
    expect(result.removed.conversations).toBe(8);
    expect(result.drained).toBe(false);
  });

  it("keeps a workspace in the rounds when its batch claimed a full one, even if the recheck erased fewer", async () => {
    const { erasure, calls } = createErasure({ "ws-a": 3 }, { revived: { "ws-a": 1 } });
    const { sweep } = createSweep({ policies: [policy("ws-a")], erasure, budget: { conversationBatchSize: 2 } });

    const result = await sweep.run();

    expect(calls).toHaveLength(3);
    expect(result.removed.conversations).toBe(3);
    expect(result.drained).toBe(true);
  });

  it("drops a workspace from the rounds once a batch comes back short", async () => {
    const { erasure, calls } = createErasure({ "ws-a": 1 });
    const { sweep } = createSweep({ policies: [policy("ws-a")], erasure, budget: { conversationBatchSize: 2 } });

    const result = await sweep.run();

    expect(calls).toHaveLength(1);
    expect(result.drained).toBe(true);
  });

  it("goes on past a workspace whose batch fails, and counts the failure without naming the workspace", async () => {
    const { erasure } = createErasure({ "ws-broken": 5, "ws-fine": 1 }, { failFor: "ws-broken" });
    const { sweep, logger } = createSweep({ policies: [policy("ws-broken"), policy("ws-fine")], erasure });

    const result = await sweep.run();

    expect(result.failed).toBe(1);
    expect(result.removed.conversations).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith({ errorName: "TypeError" }, "conversation_retention_batch_failed");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("ws-broken");
  });

  it("runs every fixed window in bounded batches until it comes back short", async () => {
    const summaries = { rows: 5 };
    const raw = { rows: 1 };
    const { erasure } = createErasure({});
    const summaryRule = rule("conversation_summaries", summaries);
    const { sweep } = createSweep({
      policies: [],
      erasure,
      rules: [summaryRule, rule("email_inbound_deliveries.raw_mime", raw)],
      budget: { ruleBatchSize: 2 },
    });

    const result = await sweep.run();

    expect(summaryRule.enforce).toHaveBeenCalledTimes(3);
    expect(summaryRule.enforce).toHaveBeenCalledWith({ now: NOW, limit: 2 });
    expect(result.removed).toEqual({ conversation_summaries: 5, "email_inbound_deliveries.raw_mime": 1 });
    expect(result.drained).toBe(true);
  });

  it("stops a rule at its batch budget and reports the run as not drained", async () => {
    const { erasure } = createErasure({});
    const { sweep } = createSweep({
      policies: [],
      erasure,
      rules: [rule("routine_states", { rows: 100 })],
      budget: { ruleBatchSize: 10, maxRuleBatches: 3 },
    });

    const result = await sweep.run();

    expect(result.removed.routine_states).toBe(30);
    expect(result.drained).toBe(false);
  });

  it("calls a rule's onRunComplete once per run with the total it removed across every batch", async () => {
    const onRunComplete = vi.fn(async () => undefined);
    const { erasure } = createErasure({});
    const { sweep } = createSweep({
      policies: [],
      erasure,
      rules: [rule("audit_events", { rows: 5 }, { onRunComplete })],
      budget: { ruleBatchSize: 2 },
    });

    await sweep.run();

    expect(onRunComplete).toHaveBeenCalledTimes(1);
    expect(onRunComplete).toHaveBeenCalledWith({ now: NOW, totalRemoved: 5 });
  });

  it("does not call a rule's onRunComplete when the rule's own batch failed", async () => {
    const onRunComplete = vi.fn(async () => undefined);
    const { erasure } = createErasure({});
    const { sweep } = createSweep({
      policies: [],
      erasure,
      rules: [rule("audit_events", { rows: 1 }, { fails: true, onRunComplete })],
    });

    await sweep.run();

    expect(onRunComplete).not.toHaveBeenCalled();
  });

  it("does not fail the run when a rule's onRunComplete rejects, since its rows already went", async () => {
    const onRunComplete = vi.fn(async () => {
      throw new Error("insert failed");
    });
    const { erasure } = createErasure({});
    const { sweep, logger } = createSweep({
      policies: [],
      erasure,
      rules: [rule("audit_events", { rows: 3 }, { onRunComplete })],
    });

    const result = await sweep.run();

    expect(result.failed).toBe(0);
    expect(result.removed.audit_events).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith({ table: "audit_events", errorName: "Error" }, "conversation_retention_rule_summary_failed");
  });

  it("runs the other windows when one rule fails", async () => {
    const { erasure } = createErasure({});
    const { sweep } = createSweep({
      policies: [],
      erasure,
      rules: [rule("routine_states", { rows: 1 }, { fails: true }), rule("conversation_summaries", { rows: 1 })],
    });

    const result = await sweep.run();

    expect(result.failed).toBe(1);
    expect(result.removed).toEqual({ conversation_summaries: 1 });
  });

  it("reports one log line and counters per table, owner and outcome, with counts only", async () => {
    const { erasure } = createErasure({ "ws-a": 2 });
    const { sweep, logger, metrics } = createSweep({
      policies: [policy("ws-a")],
      erasure,
      rules: [rule("conversation_summaries", { rows: 4 })],
    });

    await sweep.run();

    expect(logger.info).toHaveBeenCalledWith({
      removed: { conversations: 2, messages: 6, conversation_summaries: 4 },
      erasedByOwner: { audit: 2 },
      failed: 0,
      drained: true,
    }, "conversation_retention_swept");
    expect(metrics.incrementCounter.mock.calls.map(([name, options]) => [name, options.labels, options.value])).toEqual([
      ["retention_rows_removed_total", { table: "conversations" }, 2],
      ["retention_rows_removed_total", { table: "messages" }, 6],
      ["retention_rows_removed_total", { table: "conversation_summaries" }, 4],
      ["retention_rows_erased_total", { owner: "audit" }, 2],
      ["retention_sweeps_total", { outcome: "drained" }, undefined],
    ]);
    expect(JSON.stringify([logger.info.mock.calls, metrics.incrementCounter.mock.calls])).not.toContain("ws-a");
  });
});

describe("conversationRetentionPeriodicTask", () => {
  it("rejects a run that left a failed batch, so a scheduled call is retried rather than reported done", async () => {
    const failed = conversationRetentionPeriodicTask({ run: async () => ({ removed: {}, erasedByOwner: {}, failed: 1, drained: true }) });
    const clean = conversationRetentionPeriodicTask({ run: async () => ({ removed: {}, erasedByOwner: {}, failed: 0, drained: false }) });

    await expect(failed.handle.run()).rejects.toThrow(/failed batch/);
    await expect(clean.handle.run()).resolves.toBeUndefined();
    expect(failed.id).toBe("conversation-retention");
  });
});
