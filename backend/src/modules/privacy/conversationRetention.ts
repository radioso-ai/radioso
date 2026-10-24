import type { ConversationDataRetentionRule } from "../../shared/domain/conversationDataRetention.js";
import { traceOperation } from "../../shared/observability/tracing/operations.js";
import type { InactiveConversationErasure } from "./conversationErasure.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** A workspace that set a conversation retention window, and the organization it belongs to. */
export interface WorkspaceConversationRetention {
  workspaceId: string;
  accountId: string;
  retentionDays: number;
}

export interface ConversationRetentionPolicies {
  /**
   * Every workspace with a window set, least recently swept first; a workspace without one keeps its
   * conversations.
   */
  listConversationRetention(): Promise<readonly WorkspaceConversationRetention[]>;
  /** Marks the workspaces a run reached, so the next run starts with the ones it did not. */
  recordSwept(workspaceIds: readonly string[], at: Date): Promise<void>;
}

/** How much one run may do, so a backlog drains over several runs instead of one long one. */
export interface ConversationRetentionBudget {
  /** Conversations one erasure transaction removes. */
  conversationBatchSize: number;
  /** Erasure transactions that claimed a conversation, per run, across every workspace. */
  maxConversationBatches: number;
  /**
   * Checks that found nothing past a workspace's window, in the run's first round. One indexed read
   * each, so a run looks at many workspaces with nothing to erase without spending the erasure
   * budget on them. Later rounds hold only workspaces a batch already found backlogged, so this
   * budget does not apply to them; the erasure-batch budget bounds those rounds instead.
   */
  maxEmptyChecks: number;
  /** Rows one rule statement removes. */
  ruleBatchSize: number;
  /** Statements one rule runs per run. */
  maxRuleBatches: number;
}

const DEFAULT_BUDGET: ConversationRetentionBudget = {
  conversationBatchSize: 25,
  maxConversationBatches: 40,
  maxEmptyChecks: 500,
  ruleBatchSize: 500,
  maxRuleBatches: 20,
};

/** What one run removed. Counts only: a run never reports which conversation or row went. */
interface ConversationRetentionSweepResult {
  /** Rows removed per table: the conversations and their messages, and each fixed window's table. */
  readonly removed: Readonly<Record<string, number>>;
  /** Rows each owning module's eraser removed along with the conversations, beyond the cascade. */
  readonly erasedByOwner: Readonly<Record<string, number>>;
  /** Batches that failed; the next run tries them again. */
  readonly failed: number;
  /** False when the budget ran out with work left, which the next run continues. */
  readonly drained: boolean;
}

interface ConversationRetentionSweepDependencies {
  policies: ConversationRetentionPolicies;
  erasure: InactiveConversationErasure;
  rules: readonly ConversationDataRetentionRule[];
  clock: () => Date;
  logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  /** Null where the deployment exports no metrics. */
  metrics: { incrementCounter(name: string, options: { help: string; labels?: Record<string, string>; value?: number }): void } | null;
  budget?: Partial<ConversationRetentionBudget>;
}

const add = (counts: Record<string, number>, key: string, value: number): void => {
  if (value > 0) counts[key] = (counts[key] ?? 0) + value;
};

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/**
 * The one sweep that enforces retention over conversation data. A conversation its workspace's
 * window passed goes through the conversation erasure, so every copy derived from it goes too, and
 * nothing here deletes a table of its own. Then each fixed window, a rule its owning module
 * implements, removes what it passed in rows whose conversation lives on.
 *
 * Every step is a bounded batch in its own transaction, so a run never holds one long transaction
 * and a run that dies loses only the batch it was in. Batches lock with `SKIP LOCKED`, so two runs at
 * once, on two instances, remove each row once.
 */
export class ConversationRetentionSweep {
  private readonly budget: ConversationRetentionBudget;

  constructor(private readonly deps: ConversationRetentionSweepDependencies) {
    this.budget = { ...DEFAULT_BUDGET, ...deps.budget };
  }

  async run(): Promise<ConversationRetentionSweepResult> {
    return traceOperation({
      name: "privacy.retention_sweep",
      run: () => this.sweep(),
      resultAttributes: (result) => ({
        "retention.conversations": result.removed.conversations ?? 0,
        "retention.failed": result.failed,
        "retention.drained": result.drained,
      }),
    });
  }

  private async sweep(): Promise<ConversationRetentionSweepResult> {
    const now = this.deps.clock();
    const removed: Record<string, number> = {};
    const erasedByOwner: Record<string, number> = {};
    const conversations = await this.sweepConversations(now, removed, erasedByOwner);
    const rules = await this.sweepRules(now, removed);
    const result = {
      removed,
      erasedByOwner,
      failed: conversations.failed + rules.failed,
      drained: conversations.drained && rules.drained,
    };
    this.report(result);
    return result;
  }

  /**
   * One batch per workspace per round, round after round, so one workspace's backlog never keeps
   * another's from its turn. A workspace leaves the rounds once a batch claims less than a full one.
   * The run starts with the workspaces the last run did not reach, and records the ones it reached,
   * so a run that ends on its budget hands the rest to the next run rather than starting over.
   *
   * The empty-check budget applies only to the first round: once that round ends, every workspace
   * still in play already returned a full batch, so a run with many idle opted-in workspaces still
   * gives a backlogged one round after round, bounded only by the erasure-batch budget.
   */
  private async sweepConversations(
    now: Date,
    removed: Record<string, number>,
    erasedByOwner: Record<string, number>,
  ): Promise<{ failed: number; drained: boolean }> {
    const { conversationBatchSize, maxConversationBatches, maxEmptyChecks } = this.budget;
    let pending = [...await this.deps.policies.listConversationRetention()];
    const reached = new Set<string>();
    let erasing = 0;
    let empty = 0;
    let failed = 0;
    let drained = true;
    let firstRound = true;
    rounds: while (pending.length > 0) {
      const next: WorkspaceConversationRetention[] = [];
      for (const policy of pending) {
        if (erasing >= maxConversationBatches) {
          drained = false;
          break rounds;
        }
        if (firstRound && empty >= maxEmptyChecks) {
          drained = false;
          break;
        }
        reached.add(policy.workspaceId);
        try {
          const receipt = await this.deps.erasure.eraseInactiveConversations({
            workspaceId: policy.workspaceId,
            accountId: policy.accountId,
            inactiveBefore: new Date(now.getTime() - policy.retentionDays * DAY_MS),
            retentionDays: policy.retentionDays,
            limit: conversationBatchSize,
          });
          if (receipt.claimedCount === 0) {
            empty += 1;
            continue;
          }
          erasing += 1;
          add(removed, "conversations", receipt.conversationCount);
          add(removed, "messages", receipt.messageCount);
          for (const [owner, rows] of Object.entries(receipt.rowsByOwner)) add(erasedByOwner, owner, rows);
          // Decided by what was claimed: a conversation the recheck dropped still filled the batch.
          if (receipt.claimedCount >= conversationBatchSize) next.push(policy);
        } catch (error) {
          // The workspace is tried again on the next run; one failing never stops the others.
          erasing += 1;
          failed += 1;
          this.deps.logger.warn({ errorName: errorName(error) }, "conversation_retention_batch_failed");
        }
      }
      pending = next;
      firstRound = false;
    }
    if (reached.size > 0) {
      try {
        await this.deps.policies.recordSwept([...reached], now);
      } catch (error) {
        // What was erased stays erased; the next run starts from the same order and repeats a few checks.
        failed += 1;
        this.deps.logger.warn({ errorName: errorName(error) }, "conversation_retention_progress_unrecorded");
      }
    }
    return { failed, drained };
  }

  private async sweepRules(now: Date, removed: Record<string, number>): Promise<{ failed: number; drained: boolean }> {
    const { ruleBatchSize, maxRuleBatches } = this.budget;
    let failed = 0;
    let drained = true;
    for (const rule of this.deps.rules) {
      let totalRemoved = 0;
      try {
        for (let batch = 1; ; batch += 1) {
          const rows = await rule.enforce({ now, limit: ruleBatchSize });
          totalRemoved += rows;
          add(removed, rule.table, rows);
          if (rows < ruleBatchSize) break;
          if (batch >= maxRuleBatches) {
            drained = false;
            break;
          }
        }
      } catch (error) {
        failed += 1;
        this.deps.logger.warn({ table: rule.table, errorName: errorName(error) }, "conversation_retention_rule_failed");
        continue;
      }
      if (!rule.onRunComplete) continue;
      try {
        await rule.onRunComplete({ now, totalRemoved });
      } catch (error) {
        // What this run removed already committed; only the rule's own record of running failed to
        // write, so that alone does not ask the run to be retried.
        this.deps.logger.warn({ table: rule.table, errorName: errorName(error) }, "conversation_retention_rule_summary_failed");
      }
    }
    return { failed, drained };
  }

  /** One log line and the counters per run; tables and owners are a fixed, small set of labels. */
  private report(result: ConversationRetentionSweepResult): void {
    this.count(result);
    this.deps.logger.info(
      { removed: result.removed, erasedByOwner: result.erasedByOwner, failed: result.failed, drained: result.drained },
      "conversation_retention_swept",
    );
  }

  private count(result: ConversationRetentionSweepResult): void {
    const metrics = this.deps.metrics;
    if (!metrics) return;
    for (const [table, rows] of Object.entries(result.removed)) {
      metrics.incrementCounter("retention_rows_removed_total", {
        help: "Rows the conversation retention sweep removed, by table.",
        labels: { table },
        value: rows,
      });
    }
    for (const [owner, rows] of Object.entries(result.erasedByOwner)) {
      metrics.incrementCounter("retention_rows_erased_total", {
        help: "Rows owning modules' erasers removed with conversations the retention window passed, by owner.",
        labels: { owner },
        value: rows,
      });
    }
    const outcome = result.failed > 0 ? "failed" : result.drained ? "drained" : "partial";
    metrics.incrementCounter("retention_sweeps_total", {
      help: "Conversation retention sweep runs, by outcome.",
      labels: { outcome },
    });
  }
}
