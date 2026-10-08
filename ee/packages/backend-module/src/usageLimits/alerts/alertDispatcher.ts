import { sql } from "kysely";

import { createEeKysely, type EeDb } from "../../db/eeSchema.js";
import type { AccountAdministratorDirectoryPort, NoticeMailPort, UsageLimitDatabasePort } from "../../radiosoModuleTypes.js";
import { EnterpriseUsageLimitService } from "../usageLimitService.js";
import { currentPeriodStart } from "../period.js";
import { alertLevelRank, type AlertLevel } from "./alertLevelOrder.js";
import { buildAlertEmail } from "./alertContent.js";

/** An attempt is spent at claim time, so a crash mid-send still counts toward the cap — a
 *  claim can be attempted at most this many times before the dispatcher gives up on it. */
const MAX_ATTEMPTS = 5;
/** Claimed rows per sweep tick, bounded so one `run()` call cannot run unbounded. Small on
 *  purpose: a smaller batch finishes well inside its lease even when a send is slow, and a
 *  duplicate claim across batches is already deduped by the provider idempotency key. */
const BATCH_SIZE = 10;
/** How far `claimDueAlerts` pushes `next_attempt_at` out immediately on claim, so a second
 *  concurrent sweep's claim query — which only looks at `next_attempt_at <= now()` — cannot see
 *  the same row again while this attempt is still being processed. Replaced by the real backoff
 *  or a terminal state once the attempt finishes. Generous (15 min for a batch of 10) so a slow
 *  batch is very unlikely to outlive it; if one somehow did, the provider idempotency key — not
 *  this lease — is what actually prevents a duplicate delivery. */
const LEASE_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_MAX_MS);

const errorCode = (error: unknown): string => {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; name?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length > 0) {
      return candidate.code;
    }
    if (typeof candidate.name === "string" && candidate.name.length > 0) {
      return candidate.name;
    }
  }
  return "unknown_error";
};

interface ClaimedAlert {
  accountId: string;
  periodStart: string;
  level: AlertLevel;
  attempts: number;
  /** The claimed row's `created_at`, as epoch milliseconds (text, to stay precision-exact
   *  across the round trip). Re-arm deletes and reinserts the same primary key, so this is the
   *  generation token: every later UPDATE or DELETE of this claim also matches it, and it is
   *  part of the provider idempotency key, so a re-armed (new) claim never collides with an old
   *  generation's key. */
  createdAtMs: string;
}

interface UsageLimitAlertDispatcherInput {
  database: UsageLimitDatabasePort;
  audit: {
    record(input: {
      accountId?: string | null;
      workspaceId?: string | null;
      eventType: string;
      eventStatus: "success" | "failure";
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  noticeMail: NoticeMailPort;
  accountAdministrators: AccountAdministratorDirectoryPort;
  appBaseUrl: string | null;
  logger: { warn(entry: unknown, message?: string): void };
}

/**
 * The periodic sweep that turns a claimed `ee_usage_limit_alerts` row into a sent email. Claims
 * with `FOR UPDATE SKIP LOCKED` so multiple API instances running this on the same 60s tick never
 * double-send; a lower level is marked `superseded` once a higher one exists for the same
 * account/period, since an operator who already got the worse news does not need the earlier one.
 */
export class UsageLimitAlertDispatcher {
  private readonly db: EeDb;
  private readonly usage: EnterpriseUsageLimitService;

  constructor(private readonly input: UsageLimitAlertDispatcherInput) {
    this.db = createEeKysely(input.database.pool);
    this.usage = new EnterpriseUsageLimitService(input.database);
  }

  async run(): Promise<void> {
    // Bounded at 50 batches (1,250 claims) per tick: a flood of claims is processed over
    // several 60s ticks rather than monopolizing one run indefinitely.
    for (let round = 0; round < 50; round += 1) {
      const claimed = await this.claimDueAlerts(BATCH_SIZE);
      if (claimed.length === 0) {
        return;
      }
      for (const claim of claimed) {
        await this.processClaim(claim);
      }
      if (claimed.length < BATCH_SIZE) {
        return;
      }
    }
  }

  private async claimDueAlerts(limit: number): Promise<ClaimedAlert[]> {
    // No `attempts < MAX_ATTEMPTS` filter here on purpose: attempts are incremented at claim
    // time below, so a crash right after claiming the final allowed attempt would otherwise
    // leave `attempts === MAX_ATTEMPTS` and `sent_at` null forever, excluded from every future
    // sweep by a filter that only ever looks backward. `processClaim` retires that case itself
    // once reclaimed, by checking `attempts > MAX_ATTEMPTS` before doing anything else.
    const rows = await this.db
      .updateTable("ee_usage_limit_alerts")
      .set({
        attempts: sql<number>`attempts + 1`,
        next_attempt_at: sql<Date>`now() + (${LEASE_MS} * interval '1 millisecond')`,
      })
      .where(
        sql<boolean>`(account_id, period_start, level) in (
          select account_id, period_start, level
          from ee_usage_limit_alerts
          where sent_at is null
            and next_attempt_at <= now()
          order by next_attempt_at asc
          limit ${limit}
          for update skip locked
        )`,
      )
      .returning([
        "account_id",
        "level",
        "attempts",
        sql<string>`period_start::text`.as("period_start"),
        sql<string>`(extract(epoch from created_at) * 1000)::bigint::text`.as("created_at_ms"),
      ])
      .execute();

    return rows.map((row) => ({
      accountId: row.account_id,
      periodStart: row.period_start,
      level: row.level,
      attempts: row.attempts,
      createdAtMs: row.created_at_ms,
    }));
  }

  /** Matches the exact row this claim was read from, not merely its primary key — re-arm
   *  deletes and reinserts the same (account, period, level), so without this an old, still
   *  in-flight sweep could finalize (or otherwise mutate) a newer generation it never read. */
  private createdAtFence(claim: ClaimedAlert) {
    return sql<boolean>`(extract(epoch from created_at) * 1000)::bigint::text = ${claim.createdAtMs}`;
  }

  private async processClaim(claim: ClaimedAlert): Promise<void> {
    if (claim.attempts > MAX_ATTEMPTS) {
      // Reclaimed after a crash stranded it at exactly the cap with `sent_at` still null (see
      // `claimDueAlerts`). Retire it without trying to send again.
      await this.finalize(claim, { outcome: "failed" });
      await this.recordOutcomeAudit(claim, "failure", { reason: "attempts_exhausted" });
      return;
    }

    // A claim whose period has already rolled over (e.g. claimed at 23:59 on the last day of
    // the month and picked up after midnight) would email last period's numbers and a reset
    // date already in the past. Supersede it without sending; a level crossed again this
    // period claims fresh.
    if (claim.periodStart < currentPeriodStart()) {
      await this.finalize(claim, { outcome: "superseded" });
      return;
    }

    if (await this.isSuperseded(claim)) {
      await this.finalize(claim, { outcome: "superseded" });
      return;
    }

    const recipients = await this.input.accountAdministrators.list(claim.accountId);
    if (recipients.length === 0) {
      await this.finalize(claim, { outcome: "no_recipients" });
      await this.recordOutcomeAudit(claim, "failure", { recipientCount: 0, dispatchedCount: 0, reason: "no_recipients" });
      return;
    }

    const usage = await this.usage.getAccountUsage(claim.accountId, claim.periodStart);
    const conversations = usage.monthlyConversations;
    if (!conversations) {
      // The profile backing this claim no longer meters conversations (reassigned since the
      // claim was made). Re-arm on `assignProfile` should have cleared it already; this is a
      // defensive stop so a stale claim does not retry forever against data that no longer
      // supports building an email. Not a delivery failure, so no audit event.
      await this.finalize(claim, { outcome: "superseded" });
      return;
    }

    if (alertLevelRank(conversations.level) < alertLevelRank(claim.level)) {
      // The crossing this claim represents no longer holds: a reservation `release()`
      // refunded it (release never re-arms), or a top-up repaid the debt before this
      // refusal-time `grace_exhausted` claim was swept. Delete rather than finalize — fenced
      // to this exact generation — so the primary key is free for a later real crossing to
      // claim again instead of sitting behind a dead, terminal row. Not a delivery failure.
      await this.deleteClaim(claim);
      return;
    }

    const email = buildAlertEmail({
      level: claim.level,
      accountId: claim.accountId,
      planId: usage.profile?.key ?? null,
      used: conversations.used,
      capacity: conversations.capacity,
      graceLimit: conversations.grace.limit,
      resetAt: conversations.resetAt,
      appBaseUrl: this.input.appBaseUrl,
    });

    const results = await Promise.allSettled(
      recipients.map((recipient) =>
        this.input.noticeMail.send({
          to: recipient.email,
          subject: email.subject,
          kind: "usage_alert",
          content: email.content,
          // Stable across retries of this same generation (same account/period/level/
          // created_at/recipient), so a provider-side dedup window (Resend: 24h) catches a
          // resend to a recipient a prior, partially failed attempt already reached. The
          // backoff schedule (cap 30 min, 5 attempts) fits well inside that window. Scoped by
          // `createdAtMs` so a re-armed claim (new generation, same primary key) gets its own
          // key rather than colliding with — and being silently dropped by — the old one's.
          idempotencyKey: `usage_alert:${claim.accountId}:${claim.periodStart}:${claim.level}:${claim.createdAtMs}:${recipient.email}`,
        }),
      ),
    );
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const dispatchedCount = results.filter(
      (result): result is PromiseFulfilledResult<{ dispatched: boolean }> =>
        result.status === "fulfilled" && result.value.dispatched,
    ).length;

    if (failures.length === 0) {
      await this.finalize(claim, { outcome: "sent" });
      await this.recordOutcomeAudit(claim, "success", { recipientCount: recipients.length, dispatchedCount });
      return;
    }

    const lastErrorCode = errorCode(failures[failures.length - 1].reason);
    for (const failure of failures) {
      this.input.logger.warn(
        { accountId: claim.accountId, level: claim.level, attempt: claim.attempts, errorCode: errorCode(failure.reason) },
        "Usage alert email send failed",
      );
    }

    if (claim.attempts >= MAX_ATTEMPTS) {
      await this.finalize(claim, { outcome: "failed", lastErrorCode });
      await this.recordOutcomeAudit(claim, "failure", {
        recipientCount: recipients.length,
        dispatchedCount,
        reason: "attempts_exhausted",
        lastErrorCode,
      });
      return;
    }

    await this.db
      .updateTable("ee_usage_limit_alerts")
      .set({
        next_attempt_at: sql<Date>`now() + (${backoffMs(claim.attempts)} * interval '1 millisecond')`,
        last_error_code: lastErrorCode,
      })
      .where("account_id", "=", claim.accountId)
      .where("period_start", "=", sql<string>`${claim.periodStart}::date`)
      .where("level", "=", claim.level)
      .where(this.createdAtFence(claim))
      .execute();
  }

  private async deleteClaim(claim: ClaimedAlert): Promise<void> {
    await this.db
      .deleteFrom("ee_usage_limit_alerts")
      .where("account_id", "=", claim.accountId)
      .where("period_start", "=", sql<string>`${claim.periodStart}::date`)
      .where("level", "=", claim.level)
      .where(this.createdAtFence(claim))
      .execute();
  }

  private async isSuperseded(claim: ClaimedAlert): Promise<boolean> {
    const siblings = await this.db
      .selectFrom("ee_usage_limit_alerts")
      .select("level")
      .where("account_id", "=", claim.accountId)
      .where("period_start", "=", sql<string>`${claim.periodStart}::date`)
      .execute();
    return siblings.some(
      (sibling) => sibling.level !== claim.level && alertLevelRank(sibling.level) > alertLevelRank(claim.level),
    );
  }

  private async finalize(
    claim: ClaimedAlert,
    outcome: { outcome: "sent" | "no_recipients" | "superseded" | "failed"; lastErrorCode?: string },
  ): Promise<void> {
    await this.db
      .updateTable("ee_usage_limit_alerts")
      .set({
        sent_at: sql<Date>`now()`,
        outcome: outcome.outcome,
        ...(outcome.lastErrorCode ? { last_error_code: outcome.lastErrorCode } : {}),
      })
      .where("account_id", "=", claim.accountId)
      .where("period_start", "=", sql<string>`${claim.periodStart}::date`)
      .where("level", "=", claim.level)
      .where(this.createdAtFence(claim))
      .execute();
  }

  private async recordOutcomeAudit(
    claim: ClaimedAlert,
    eventStatus: "success" | "failure",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.input.audit.record({
      accountId: claim.accountId,
      workspaceId: null,
      eventType: "usage_limits.alert_delivered",
      eventStatus,
      metadata: { level: claim.level, periodStart: claim.periodStart, ...metadata },
    });
  }
}
