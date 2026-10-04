import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { PLAN_CATALOG, type UsageCountKind } from "@radioso/plan-catalog";

import { createEeKysely, type EeDb } from "../db/eeSchema.js";
import type {
  AnswerUsageKind,
  DocumentCapacityReadPort,
  DocumentCapacityUsage,
  IndexedStorageReservationInput,
  MonthlyIndexedContentReservationInput,
  UsageLimitDatabasePort,
  UsageLimitPolicy,
  UsageLimitReservation,
} from "../radiosoModuleTypes.js";
import { UsageLimitAccountNotFoundError, UsageLimitExceededError } from "./errors.js";
import { currentPeriodStart, nextPeriodStart } from "./period.js";

export interface UsageLimitProfile {
  key: string;
  displayName: string;
  monthlyAnswerLimit: number | null;
  storedDocumentLimit: number | null;
  storedIndexedByteLimit: number | null;
  monthlyIndexedByteLimit: number | null;
  /** When set, the account is metered in conversations (see `usageWeight`)
   *  and `monthlyAnswerLimit` is ignored. */
  monthlyConversationLimit: number | null;
  /** A customer conversation is charged once per this many replies. */
  repliesPerConversation: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The countable units this service meters, derived from
 * `@radioso/plan-catalog`'s `UsageCountKind` rather than redeclared by hand, so
 * a kind the catalog adds shows up here automatically. `"other"` is excluded:
 * it is a reserved weight in the catalog for surfaces nothing maps to yet, and
 * `surfaceWeight()` below never returns it. Admitting it here would push an
 * `other: 0` entry into every `byKind` usage summary — including the
 * `/accounts/:id/usage` and `/me` HTTP responses — for a kind no charge ever
 * produces.
 */
export type UsageKind = Exclude<UsageCountKind, "other">;

export const USAGE_KINDS: readonly UsageKind[] = (
  Object.keys(PLAN_CATALOG.countsAs) as UsageCountKind[]
).filter((kind): kind is UsageKind => kind !== "other");

export interface AccountUsageSummary {
  accountId: string;
  profile: UsageLimitProfile | null;
  monthlyAnswers: {
    periodStart: string;
    resetAt: string;
    used: number;
    limit: number | null;
  };
  storedDocuments: {
    used: number;
    limit: number | null;
  };
  storedIndexedBytes: {
    used: number;
    limit: number | null;
  };
  monthlyIndexedBytes: {
    periodStart: string;
    resetAt: string;
    used: number;
    limit: number | null;
  };
  /** Present when the profile meters conversations. Values are conversations,
   *  to one decimal, because ten test runs are one. */
  monthlyConversations: {
    periodStart: string;
    resetAt: string;
    used: number;
    limit: number;
    /** Remaining prepaid top-up conversations. Never expire. */
    credits: number;
    byKind: Record<UsageKind, number>;
  } | null;
}

/** Everything is metered in tenths of a conversation so "ten test runs are one" is integer math. */
export const TENTHS_PER_CONVERSATION = 10;

type SurfaceWeight = {
  kind: UsageKind;
  tenths: number;
  /** Customer conversations pay once per block of replies; everything else pays per call. */
  perConversationBlock: boolean;
};

/** `PLAN_CATALOG.countsAs[kind]` conversation-equivalents, as integer tenths. */
const tenthsFor = (kind: UsageKind): number => PLAN_CATALOG.countsAs[kind] * TENTHS_PER_CONVERSATION;

/**
 * The public counting table on radioso.ai/pricing, keyed on the `usage` kind every
 * caller declares. Keep it in step with `COUNTS_AS` on the website. `surface` is
 * attribution only (logs/audit) and never drives pricing here — an unfamiliar or
 * mislabeled surface string cannot silently bill as a full customer conversation.
 * The *weight* each kind costs comes from `PLAN_CATALOG.countsAs`, the single
 * source of truth for the counting table, so the two can never drift apart.
 */
export const usageWeight = (usage: AnswerUsageKind): SurfaceWeight | null => {
  switch (usage) {
    // The widget greeting on open. A visitor who opens the widget and leaves
    // has not had a conversation.
    case "greeting":
      return null;
    case "copilot_turn":
      return { kind: "copilot", tenths: tenthsFor("copilot"), perConversationBlock: false };
    // The dashboard test chat, Workbench replays, eval runs, and test executions:
    // two for one. A test reply is a full turn, so this is cheaper than a
    // customer conversation without being sold at cost.
    case "test_run":
      return { kind: "test_run", tenths: tenthsFor("test_run"), perConversationBlock: false };
    // Every Pulse report is on demand. There is no scheduled run.
    case "pulse_report":
      return { kind: "pulse_report", tenths: tenthsFor("pulse_report"), perConversationBlock: false };
    // Standalone answers over the API: each call is its own conversation.
    case "standalone_answer":
      return { kind: "conversation", tenths: tenthsFor("conversation"), perConversationBlock: false };
    // Every customer channel: website_embed, anonymous, slack, whatsapp, agent_api, mcp, assistant.
    case "conversation_reply":
      return { kind: "conversation", tenths: tenthsFor("conversation"), perConversationBlock: true };
    default: {
      const exhaustive: never = usage;
      throw new Error(`Unhandled answer usage kind: ${String(exhaustive)}`);
    }
  }
};

const DOCUMENT_RESERVATION_TTL_MS = 10 * 60 * 1000;
const STORAGE_RESERVATION_TTL_MS = 10 * 60 * 1000;

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const toNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return null;
};

const mapProfile = (row: {
  key: string;
  display_name: string;
  monthly_answer_limit: number | null;
  stored_document_limit: number | null;
  stored_indexed_byte_limit: number | string | null;
  monthly_indexed_byte_limit: number | string | null;
  monthly_conversation_limit: number | null;
  replies_per_conversation: number;
  created_at: Date;
  updated_at: Date;
}): UsageLimitProfile => ({
  key: row.key,
  displayName: row.display_name,
  monthlyAnswerLimit: row.monthly_answer_limit,
  storedDocumentLimit: row.stored_document_limit,
  storedIndexedByteLimit: toNullableNumber(row.stored_indexed_byte_limit),
  monthlyIndexedByteLimit: toNullableNumber(row.monthly_indexed_byte_limit),
  monthlyConversationLimit: row.monthly_conversation_limit,
  repliesPerConversation: row.replies_per_conversation,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class EnterpriseUsageLimitService implements UsageLimitPolicy, DocumentCapacityReadPort {
  private readonly db: EeDb;

  constructor(private readonly database: UsageLimitDatabasePort) {
    this.db = createEeKysely(this.database.pool);
  }

  async listProfiles(): Promise<UsageLimitProfile[]> {
    const rows = await this.db
      .selectFrom("ee_usage_limit_profiles")
      .select([
        "key",
        "display_name",
        "monthly_answer_limit",
        "stored_document_limit",
        "stored_indexed_byte_limit",
        "monthly_indexed_byte_limit",
        "monthly_conversation_limit",
        "replies_per_conversation",
        "created_at",
        "updated_at",
      ])
      .orderBy("key", "asc")
      .execute();

    return rows.map(mapProfile);
  }

  async upsertProfile(input: {
    key: string;
    displayName: string;
    monthlyAnswerLimit: number | null;
    storedDocumentLimit: number | null;
    storedIndexedByteLimit?: number | null;
    monthlyIndexedByteLimit?: number | null;
    monthlyConversationLimit?: number | null;
    repliesPerConversation?: number;
  }): Promise<UsageLimitProfile> {
    // An omitted optional field preserves the stored value on update; an
    // explicit `null` clears it. Only fields the caller actually named go into
    // the ON CONFLICT SET clause, so Postgres leaves the rest of the row alone.
    const hasStoredIndexedByteLimit = "storedIndexedByteLimit" in input;
    const hasMonthlyIndexedByteLimit = "monthlyIndexedByteLimit" in input;
    const hasMonthlyConversationLimit = "monthlyConversationLimit" in input;
    const hasRepliesPerConversation = "repliesPerConversation" in input;

    const row = await this.db
      .insertInto("ee_usage_limit_profiles")
      .values({
        key: input.key,
        display_name: input.displayName,
        monthly_answer_limit: input.monthlyAnswerLimit,
        stored_document_limit: input.storedDocumentLimit,
        monthly_conversation_limit: input.monthlyConversationLimit ?? null,
        replies_per_conversation: input.repliesPerConversation ?? 10,
        stored_indexed_byte_limit:
          input.storedIndexedByteLimit === null || input.storedIndexedByteLimit === undefined
            ? null
            : String(input.storedIndexedByteLimit),
        monthly_indexed_byte_limit:
          input.monthlyIndexedByteLimit === null || input.monthlyIndexedByteLimit === undefined
            ? null
            : String(input.monthlyIndexedByteLimit),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          display_name: (eb) => eb.ref("excluded.display_name"),
          monthly_answer_limit: (eb) => eb.ref("excluded.monthly_answer_limit"),
          stored_document_limit: (eb) => eb.ref("excluded.stored_document_limit"),
          ...(hasStoredIndexedByteLimit
            ? { stored_indexed_byte_limit: (eb) => eb.ref("excluded.stored_indexed_byte_limit") }
            : {}),
          ...(hasMonthlyIndexedByteLimit
            ? { monthly_indexed_byte_limit: (eb) => eb.ref("excluded.monthly_indexed_byte_limit") }
            : {}),
          ...(hasMonthlyConversationLimit
            ? { monthly_conversation_limit: (eb) => eb.ref("excluded.monthly_conversation_limit") }
            : {}),
          ...(hasRepliesPerConversation
            ? { replies_per_conversation: (eb) => eb.ref("excluded.replies_per_conversation") }
            : {}),
          updated_at: sql<Date>`now()`,
        }),
      )
      .returning([
        "key",
        "display_name",
        "monthly_answer_limit",
        "stored_document_limit",
        "stored_indexed_byte_limit",
        "monthly_indexed_byte_limit",
        "monthly_conversation_limit",
        "replies_per_conversation",
        "created_at",
        "updated_at",
      ])
      .executeTakeFirstOrThrow();

    return mapProfile(row);
  }

  async assignProfile(accountId: string, profileKey: string | null): Promise<AccountUsageSummary> {
    if (profileKey === null) {
      await this.db
        .deleteFrom("ee_usage_limit_account_assignments")
        .where("account_id", "=", accountId)
        .execute();
      return this.getAccountUsage(accountId);
    }

    await this.db
      .insertInto("ee_usage_limit_account_assignments")
      .values({ account_id: accountId, profile_key: profileKey })
      .onConflict((oc) =>
        oc.column("account_id").doUpdateSet({
          profile_key: (eb) => eb.ref("excluded.profile_key"),
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();

    return this.getAccountUsage(accountId);
  }

  async getAccountUsage(accountId: string, periodStart = currentPeriodStart()): Promise<AccountUsageSummary> {
    const profile = await this.findProfileForAccount(accountId);
    const answerCounter = await this.db
      .selectFrom("ee_usage_limit_answer_counters")
      .select("used_count")
      .where("account_id", "=", accountId)
      .where("period_start", "=", sql<string>`${periodStart}::date`)
      .executeTakeFirst();
    const persistedAnswerCount = await this.countPersistedAssistantAnswers(accountId, periodStart);
    const storedDocumentCount = await this.countStoredDocuments(accountId, this.db, false);
    const storedIndexedBytes = await this.sumStoredIndexedBytes(accountId, this.db, false);
    const monthlyIndexedBytes = await this.readMonthlyIndexedBytes(accountId, periodStart);

    return {
      accountId,
      profile,
      monthlyAnswers: {
        periodStart,
        resetAt: nextPeriodStart(periodStart),
        used: Math.max(answerCounter?.used_count ?? 0, persistedAnswerCount),
        // A conversation-metered profile ignores monthlyAnswerLimit (see
        // UsageLimitProfile.monthlyConversationLimit), so that cap is not enforced.
        limit: typeof profile?.monthlyConversationLimit === "number" ? null : profile?.monthlyAnswerLimit ?? null,
      },
      storedDocuments: {
        used: storedDocumentCount,
        limit: profile?.storedDocumentLimit ?? null,
      },
      storedIndexedBytes: {
        used: storedIndexedBytes,
        limit: profile?.storedIndexedByteLimit ?? null,
      },
      monthlyIndexedBytes: {
        periodStart,
        resetAt: nextPeriodStart(periodStart),
        used: monthlyIndexedBytes,
        limit: profile?.monthlyIndexedByteLimit ?? null,
      },
      monthlyConversations: profile ? await this.readConversationUsage(accountId, profile, periodStart) : null,
    };
  }

  async getDocumentCapacityUsage(input: { accountId?: string | null; workspaceId: string }): Promise<DocumentCapacityUsage> {
    if (!input.accountId) return { storedDocuments: { used: 0, limit: null }, storedIndexedBytes: { used: 0, limit: null }, monthlyIndexedBytes: { used: 0, limit: null } };
    const usage = await this.getAccountUsage(input.accountId);
    return { storedDocuments: usage.storedDocuments, storedIndexedBytes: usage.storedIndexedBytes, monthlyIndexedBytes: usage.monthlyIndexedBytes };
  }

  async reserveAnswer(input: {
    accountId?: string | null;
    workspaceId: string;
    surface: string;
    usage: AnswerUsageKind;
    conversationId?: string | null;
  }): Promise<UsageLimitReservation> {
    const accountId = await this.resolveAccountId(input);
    if (!accountId) {
      return noopReservation;
    }

    const profile = await this.findProfileForAccount(accountId);
    if (!profile) {
      return noopReservation;
    }
    if (typeof profile.monthlyConversationLimit === "number") {
      return this.reserveConversationUnits(accountId, profile, input);
    }

    const limit = profile.monthlyAnswerLimit;
    if (typeof limit !== "number") {
      return noopReservation;
    }

    const periodStart = currentPeriodStart();
    await this.db
      .insertInto("ee_usage_limit_answer_counters")
      .values({
        account_id: accountId,
        period_start: sql<string>`${periodStart}::date`,
        used_count: 0,
      })
      .onConflict((oc) => oc.columns(["account_id", "period_start"]).doNothing())
      .execute();

    const rows = await this.db
      .updateTable("ee_usage_limit_answer_counters")
      .set({
        used_count: sql<number>`used_count + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where("account_id", "=", accountId)
      .where("period_start", "=", sql<string>`${periodStart}::date`)
      .where("used_count", "<", limit)
      .returning("used_count")
      .execute();

    if (rows.length === 0) {
      const counter = await this.db
        .selectFrom("ee_usage_limit_answer_counters")
        .select("used_count")
        .where("account_id", "=", accountId)
        .where("period_start", "=", sql<string>`${periodStart}::date`)
        .executeTakeFirst();
      throw new UsageLimitExceededError({
        profileKey: profile.key,
        resource: "monthly_answers",
        limit,
        used: counter?.used_count ?? limit,
        periodStart,
        resetAt: nextPeriodStart(periodStart),
      });
    }

    const db = this.db;
    return {
      async commit() {},
      release: async () => {
        await db
          .updateTable("ee_usage_limit_answer_counters")
          .set({
            used_count: sql<number>`greatest(used_count - 1, 0)`,
            updated_at: sql<Date>`now()`,
          })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .execute();
      },
    };
  }

  /**
   * One unit for everything. A customer conversation pays once per block of
   * `repliesPerConversation` replies; operator work pays per call at its
   * weight; prepaid credits absorb whatever runs past the plan limit.
   */
  private async reserveConversationUnits(
    accountId: string,
    profile: UsageLimitProfile,
    input: { usage: AnswerUsageKind; conversationId?: string | null },
  ): Promise<UsageLimitReservation> {
    const weight = usageWeight(input.usage);
    if (!weight) {
      return noopReservation;
    }
    const periodStart = currentPeriodStart();
    const limitTenths = (profile.monthlyConversationLimit ?? 0) * TENTHS_PER_CONVERSATION;

    let releaseReply: (() => Promise<void>) | null = null;
    if (weight.perConversationBlock && input.conversationId) {
      const conversationId = input.conversationId;
      const replyCount = await this.bumpConversationReplies(accountId, periodStart, conversationId, 1);
      releaseReply = async () => {
        await this.bumpConversationReplies(accountId, periodStart, conversationId, -1);
      };
      // Reply 1 opens the first block, reply 11 the second, and so on. Every
      // other reply sits inside a block that has already been paid for.
      if ((replyCount - 1) % profile.repliesPerConversation !== 0) {
        return { commit: async () => {}, release: releaseReply };
      }
    }

    let unit: UsageLimitReservation;
    try {
      unit = await this.reserveTenths(accountId, profile, periodStart, weight.kind, weight.tenths, limitTenths);
    } catch (error) {
      if (releaseReply) {
        await releaseReply();
      }
      throw error;
    }

    return {
      commit: async () => {},
      release: async () => {
        await unit.release();
        if (releaseReply) {
          await releaseReply();
        }
      },
    };
  }

  private async bumpConversationReplies(
    accountId: string,
    periodStart: string,
    conversationId: string,
    delta: 1 | -1,
  ): Promise<number> {
    const row = await this.db
      .insertInto("ee_usage_limit_conversation_replies")
      .values({
        account_id: accountId,
        period_start: sql<string>`${periodStart}::date`,
        conversation_id: conversationId,
        reply_count: delta > 0 ? 1 : 0,
      })
      .onConflict((oc) =>
        oc.columns(["account_id", "period_start", "conversation_id"]).doUpdateSet({
          reply_count: sql<number>`greatest(ee_usage_limit_conversation_replies.reply_count + ${delta}, 0)`,
          updated_at: sql<Date>`now()`,
        }),
      )
      .returning("reply_count")
      .executeTakeFirstOrThrow();
    return row.reply_count;
  }

  /**
   * Charge `tenths` against the period's allowance plus prepaid credits, in one
   * transaction serialised on the account's counter row. Credits are consumed
   * only for the part of a charge that runs past the plan limit, so the plan
   * allowance is always spent first and credits carry over month to month.
   */
  private async reserveTenths(
    accountId: string,
    profile: UsageLimitProfile,
    periodStart: string,
    kind: UsageKind,
    tenths: number,
    limitTenths: number,
  ): Promise<UsageLimitReservation> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("ee_usage_limit_unit_counters")
        .values({ account_id: accountId, period_start: sql<string>`${periodStart}::date`, used_tenths: 0 })
        .onConflict((oc) => oc.columns(["account_id", "period_start"]).doNothing())
        .execute();
      await trx
        .insertInto("ee_usage_limit_credits")
        .values({ account_id: accountId, balance_tenths: 0 })
        .onConflict((oc) => oc.column("account_id").doNothing())
        .execute();

      const counter = await trx
        .selectFrom("ee_usage_limit_unit_counters")
        .select("used_tenths")
        .where("account_id", "=", accountId)
        .where("period_start", "=", sql<string>`${periodStart}::date`)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const credits = await trx
        .selectFrom("ee_usage_limit_credits")
        .select("balance_tenths")
        .where("account_id", "=", accountId)
        .executeTakeFirstOrThrow();

      const usedBefore = counter.used_tenths;
      const usedAfter = usedBefore + tenths;
      // The part of this charge that runs past the plan limit — negative (and
      // therefore never over budget) while usedBefore is already within the
      // limit. Checking `overshoot > balance` here, not `usedAfter > limit +
      // balance`, matters once a prior call has already dipped into credits:
      // `max(limitTenths, usedBefore)` tracks the account's high-water mark,
      // so a later call is only charged (and only needs to fit) against what
      // IS still unpaid, not against the limit re-added on top of it.
      const overshoot = usedAfter - Math.max(limitTenths, usedBefore);
      if (overshoot > credits.balance_tenths) {
        throw new UsageLimitExceededError({
          profileKey: profile.key,
          resource: "monthly_conversations",
          limit: profile.monthlyConversationLimit ?? 0,
          used: usedBefore / TENTHS_PER_CONVERSATION,
          periodStart,
          resetAt: nextPeriodStart(periodStart),
        });
      }

      await trx
        .updateTable("ee_usage_limit_unit_counters")
        .set({ used_tenths: usedAfter, updated_at: sql<Date>`now()` })
        .where("account_id", "=", accountId)
        .where("period_start", "=", sql<string>`${periodStart}::date`)
        .execute();
      if (overshoot > 0) {
        await trx
          .updateTable("ee_usage_limit_credits")
          .set({ balance_tenths: sql<number>`balance_tenths - ${overshoot}`, updated_at: sql<Date>`now()` })
          .where("account_id", "=", accountId)
          .execute();
      }
      await trx
        .insertInto("ee_usage_limit_unit_kind_counters")
        .values({ account_id: accountId, period_start: sql<string>`${periodStart}::date`, kind, used_tenths: tenths })
        .onConflict((oc) =>
          oc.columns(["account_id", "period_start", "kind"]).doUpdateSet({
            used_tenths: sql<number>`ee_usage_limit_unit_kind_counters.used_tenths + ${tenths}`,
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    });

    const db = this.db;
    return {
      async commit() {},
      release: async () => {
        await db.transaction().execute(async (trx) => {
          // Recompute the refund from current occupancy under the same row
          // lock `reserveTenths` uses, rather than replaying what this specific
          // reservation drew from credits when it was made. Releases can land
          // out of order (e.g. a plan-funded reservation released after a
          // later, credit-funded one), and only the current totals say whether
          // the tenths being freed were, in the end, funded by the plan or by
          // credits.
          const counter = await trx
            .selectFrom("ee_usage_limit_unit_counters")
            .select("used_tenths")
            .where("account_id", "=", accountId)
            .where("period_start", "=", sql<string>`${periodStart}::date`)
            .forUpdate()
            .executeTakeFirstOrThrow();

          const usedBefore = counter.used_tenths;
          const usedAfter = Math.max(usedBefore - tenths, 0);
          const refund = Math.max(0, usedBefore - Math.max(limitTenths, usedAfter));

          await trx
            .updateTable("ee_usage_limit_unit_counters")
            .set({ used_tenths: usedAfter, updated_at: sql<Date>`now()` })
            .where("account_id", "=", accountId)
            .where("period_start", "=", sql<string>`${periodStart}::date`)
            .execute();
          if (refund > 0) {
            await trx
              .updateTable("ee_usage_limit_credits")
              .set({ balance_tenths: sql<number>`balance_tenths + ${refund}`, updated_at: sql<Date>`now()` })
              .where("account_id", "=", accountId)
              .execute();
          }
          await trx
            .updateTable("ee_usage_limit_unit_kind_counters")
            .set({ used_tenths: sql<number>`greatest(used_tenths - ${tenths}, 0)`, updated_at: sql<Date>`now()` })
            .where("account_id", "=", accountId)
            .where("period_start", "=", sql<string>`${periodStart}::date`)
            .where("kind", "=", kind)
            .execute();
        });
      },
    };
  }

  /**
   * Prepaid top-up. Called by the Stripe webhook and the operator console.
   * Idempotent on `(accountId, reference)` — a Stripe event id or any other
   * caller-supplied unique string — so a webhook replay never double-grants.
   */
  async addCredits(input: {
    accountId: string;
    conversations: number;
    reference: string;
  }): Promise<{ credits: number; applied: boolean }> {
    const { accountId, conversations, reference } = input;
    if (!Number.isInteger(conversations) || conversations <= 0) {
      throw new Error("conversations must be a positive integer");
    }
    if (!reference || reference.length > 200) {
      throw new Error("reference must be a non-empty string of at most 200 characters");
    }
    const tenths = conversations * TENTHS_PER_CONVERSATION;

    return this.db.transaction().execute(async (trx) => {
      const account = await trx
        .selectFrom("accounts")
        .select("id")
        .where("id", "=", accountId)
        .executeTakeFirst();
      if (!account) {
        throw new UsageLimitAccountNotFoundError({ accountId });
      }

      const grant = await trx
        .insertInto("ee_usage_limit_credit_grants")
        .values({ account_id: accountId, reference, conversations })
        .onConflict((oc) => oc.columns(["account_id", "reference"]).doNothing())
        .returning("account_id")
        .executeTakeFirst();
      const applied = Boolean(grant);

      if (applied) {
        await trx
          .insertInto("ee_usage_limit_credits")
          .values({ account_id: accountId, balance_tenths: tenths })
          .onConflict((oc) =>
            oc.column("account_id").doUpdateSet({
              balance_tenths: sql<number>`ee_usage_limit_credits.balance_tenths + ${tenths}`,
              updated_at: sql<Date>`now()`,
            }),
          )
          .execute();
      }

      const credits = await trx
        .selectFrom("ee_usage_limit_credits")
        .select("balance_tenths")
        .where("account_id", "=", accountId)
        .executeTakeFirst();

      return { credits: (credits?.balance_tenths ?? 0) / TENTHS_PER_CONVERSATION, applied };
    });
  }

  private async readConversationUsage(
    accountId: string,
    profile: UsageLimitProfile,
    periodStart: string,
  ): Promise<AccountUsageSummary["monthlyConversations"]> {
    if (typeof profile.monthlyConversationLimit !== "number") {
      return null;
    }
    const [counter, credits, kinds] = await Promise.all([
      this.db
        .selectFrom("ee_usage_limit_unit_counters")
        .select("used_tenths")
        .where("account_id", "=", accountId)
        .where("period_start", "=", sql<string>`${periodStart}::date`)
        .executeTakeFirst(),
      this.db
        .selectFrom("ee_usage_limit_credits")
        .select("balance_tenths")
        .where("account_id", "=", accountId)
        .executeTakeFirst(),
      this.db
        .selectFrom("ee_usage_limit_unit_kind_counters")
        .select(["kind", "used_tenths"])
        .where("account_id", "=", accountId)
        .where("period_start", "=", sql<string>`${periodStart}::date`)
        .execute(),
    ]);
    const byKind = Object.fromEntries(USAGE_KINDS.map((kind) => [kind, 0])) as Record<UsageKind, number>;
    for (const row of kinds) {
      if ((USAGE_KINDS as readonly string[]).includes(row.kind)) {
        byKind[row.kind as UsageKind] = row.used_tenths / TENTHS_PER_CONVERSATION;
      }
    }
    return {
      periodStart,
      resetAt: nextPeriodStart(periodStart),
      used: (counter?.used_tenths ?? 0) / TENTHS_PER_CONVERSATION,
      limit: profile.monthlyConversationLimit,
      credits: (credits?.balance_tenths ?? 0) / TENTHS_PER_CONVERSATION,
      byKind,
    };
  }

  async reserveMonthlyIndexedContent(input: MonthlyIndexedContentReservationInput): Promise<UsageLimitReservation> {
    const accountId = await this.resolveAccountId(input);
    if (!accountId) {
      return noopReservation;
    }

    const requestedBytes = Math.max(0, Math.floor(input.contentSizeBytes ?? 0));
    if (requestedBytes === 0) {
      return noopReservation;
    }

    const profile = await this.findProfileForAccount(accountId);
    const limit = profile?.monthlyIndexedByteLimit;
    const enforcement = profile && typeof limit === "number"
      ? { profileKey: profile.key, limit }
      : null;

    const periodStart = currentPeriodStart();
    await this.db
      .insertInto("ee_usage_limit_monthly_indexed_byte_counters")
      .values({
        account_id: accountId,
        period_start: sql<string>`${periodStart}::date`,
        used_bytes: "0",
      })
      .onConflict((oc) => oc.columns(["account_id", "period_start"]).doNothing())
      .execute();

    const rows = enforcement
      ? await this.db
          .updateTable("ee_usage_limit_monthly_indexed_byte_counters")
          .set({
            used_bytes: sql<string>`used_bytes + ${requestedBytes}`,
            updated_at: sql<Date>`now()`,
          })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .where(sql<boolean>`used_bytes + ${requestedBytes} <= ${enforcement.limit}`)
          .returning("used_bytes")
          .execute()
      : await this.db
          .updateTable("ee_usage_limit_monthly_indexed_byte_counters")
          .set({
            used_bytes: sql<string>`used_bytes + ${requestedBytes}`,
            updated_at: sql<Date>`now()`,
          })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .returning("used_bytes")
          .execute();

    if (enforcement && rows.length === 0) {
      const used = await this.readMonthlyIndexedBytes(accountId, periodStart);
      throw new UsageLimitExceededError({
        profileKey: enforcement.profileKey,
        resource: "monthly_indexed_bytes",
        limit: enforcement.limit,
        used,
        periodStart,
        resetAt: nextPeriodStart(periodStart),
      });
    }

    const db = this.db;
    return {
      async commit() {},
      release: async () => {
        await db
          .updateTable("ee_usage_limit_monthly_indexed_byte_counters")
          .set({
            used_bytes: sql<string>`greatest(used_bytes - ${requestedBytes}, 0)`,
            updated_at: sql<Date>`now()`,
          })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .execute();
      },
    };
  }

  async reserveIndexedStorage(input: IndexedStorageReservationInput): Promise<UsageLimitReservation> {
    const accountId = await this.resolveAccountId(input);
    if (!accountId) {
      return noopReservation;
    }

    const profile = await this.findProfileForAccount(accountId);
    const limit = profile?.storedIndexedByteLimit;
    if (!profile || typeof limit !== "number") {
      return noopReservation;
    }

    const requestedBytes = Math.max(0, Math.floor(input.contentSizeBytes ?? 0));
    if (requestedBytes === 0) {
      return noopReservation;
    }

    const reservationId = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      await this.lockAccountUsage(trx, accountId);
      await trx
        .deleteFrom("ee_usage_limit_storage_reservations")
        .where("account_id", "=", accountId)
        .where("expires_at", "<=", sql<Date>`now()`)
        .execute();
      const used = await this.sumStoredIndexedBytes(accountId, trx, true);
      if (used + requestedBytes > limit) {
        throw new UsageLimitExceededError({
          profileKey: profile.key,
          resource: "stored_indexed_bytes",
          limit,
          used,
        });
      }

      await trx
        .insertInto("ee_usage_limit_storage_reservations")
        .values({
          id: reservationId,
          account_id: accountId,
          workspace_id: input.workspaceId,
          bytes_reserved: String(requestedBytes),
          expires_at: new Date(Date.now() + STORAGE_RESERVATION_TTL_MS),
        })
        .execute();
    });

    return {
      commit: async () => {
        await this.releaseStorageReservation(reservationId);
      },
      release: async () => {
        await this.releaseStorageReservation(reservationId);
      },
    };
  }

  async reserveDocument(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceKind: string;
    externalDocumentId?: string | null;
  }): Promise<UsageLimitReservation> {
    const accountId = await this.resolveAccountId(input);
    if (!accountId) {
      return noopReservation;
    }

    const profile = await this.findProfileForAccount(accountId);
    const limit = profile?.storedDocumentLimit;
    if (!profile || typeof limit !== "number") {
      return noopReservation;
    }

    if (await this.isExistingInlineExternalDocument(input)) {
      return noopReservation;
    }

    const reservationId = randomUUID();
    await this.db.transaction().execute(async (trx) => {
      await this.lockAccountUsage(trx, accountId);
      await trx
        .deleteFrom("ee_usage_limit_document_reservations")
        .where("account_id", "=", accountId)
        .where("expires_at", "<=", sql<Date>`now()`)
        .execute();
      const used = await this.countStoredDocuments(accountId, trx, true);
      if (used >= limit) {
        throw new UsageLimitExceededError({
          profileKey: profile.key,
          resource: "stored_documents",
          limit,
          used,
        });
      }

      await trx
        .insertInto("ee_usage_limit_document_reservations")
        .values({
          id: reservationId,
          account_id: accountId,
          workspace_id: input.workspaceId,
          expires_at: new Date(Date.now() + DOCUMENT_RESERVATION_TTL_MS),
        })
        .execute();
    });

    return {
      commit: async () => {
        await this.releaseDocumentReservation(reservationId);
      },
      release: async () => {
        await this.releaseDocumentReservation(reservationId);
      },
    };
  }

  /**
   * The plan key a workspace's account is assigned to, or `null` when the
   * workspace, its account, or an assignment is missing. Read-only; the
   * managed-model policy is the consumer.
   */
  async findProfileKeyForWorkspace(workspaceId: string): Promise<string | null> {
    const accountId = await this.resolveAccountId({ workspaceId });
    if (!accountId) {
      return null;
    }
    const profile = await this.findProfileForAccount(accountId);
    return profile?.key ?? null;
  }

  private async lockAccountUsage(db: EeDb, accountId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${accountId}, 0))`.execute(db);
  }

  private async resolveAccountId(input: {
    accountId?: string | null;
    workspaceId: string;
  }): Promise<string | null> {
    if (input.accountId) {
      return input.accountId;
    }

    const workspace = await this.db
      .selectFrom("workspaces")
      .select("account_id")
      .where("id", "=", input.workspaceId)
      .executeTakeFirst();
    return workspace?.account_id ?? null;
  }

  private async findProfileForAccount(accountId: string): Promise<UsageLimitProfile | null> {
    const row = await this.db
      .selectFrom("ee_usage_limit_account_assignments as a")
      .innerJoin("ee_usage_limit_profiles as p", "p.key", "a.profile_key")
      .select([
        "p.key",
        "p.display_name",
        "p.monthly_answer_limit",
        "p.stored_document_limit",
        "p.stored_indexed_byte_limit",
        "p.monthly_indexed_byte_limit",
        "p.monthly_conversation_limit",
        "p.replies_per_conversation",
        "p.created_at",
        "p.updated_at",
      ])
      .where("a.account_id", "=", accountId)
      .executeTakeFirst();

    return row ? mapProfile(row) : null;
  }

  private async sumStoredIndexedBytes(
    accountId: string,
    db: EeDb,
    includeReservations: boolean,
  ): Promise<number> {
    const row = await db
      .selectFrom("documents as d")
      .innerJoin("workspaces as w", "w.id", "d.workspace_id")
      .select(sql<string>`coalesce(sum(d.content_size_bytes), 0)::text`.as("bytes"))
      .where("w.account_id", "=", accountId)
      .executeTakeFirst();
    const documentBytes = Number(row?.bytes ?? "0");
    if (!includeReservations) {
      return documentBytes;
    }

    const reservations = await db
      .selectFrom("ee_usage_limit_storage_reservations")
      .select(sql<string>`coalesce(sum(bytes_reserved), 0)::text`.as("bytes"))
      .where("account_id", "=", accountId)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();

    return documentBytes + Number(reservations?.bytes ?? "0");
  }

  private async readMonthlyIndexedBytes(accountId: string, periodStart: string): Promise<number> {
    const row = await this.db
      .selectFrom("ee_usage_limit_monthly_indexed_byte_counters")
      .select("used_bytes")
      .where("account_id", "=", accountId)
      .where("period_start", "=", sql<string>`${periodStart}::date`)
      .executeTakeFirst();
    return Number(row?.used_bytes ?? 0);
  }

  private async releaseStorageReservation(reservationId: string): Promise<void> {
    await this.db
      .deleteFrom("ee_usage_limit_storage_reservations")
      .where("id", "=", reservationId)
      .execute();
  }

  private async countPersistedAssistantAnswers(accountId: string, periodStart: string): Promise<number> {
    const answers = await this.db
      .selectFrom("messages as m")
      .innerJoin("workspaces as w", "w.id", "m.workspace_id")
      .select(sql<string>`count(*)::text`.as("count"))
      .where("w.account_id", "=", accountId)
      .where("m.role", "=", "assistant")
      .where("m.created_at", ">=", sql<Date>`${periodStart}::date`)
      .where("m.created_at", "<", sql<Date>`${nextPeriodStart(periodStart)}::timestamptz`)
      .executeTakeFirst();

    return Number(answers?.count ?? "0");
  }

  private async countStoredDocuments(
    accountId: string,
    db: EeDb,
    includeReservations: boolean,
  ): Promise<number> {
    const documents = await db
      .selectFrom("documents as d")
      .innerJoin("workspaces as w", "w.id", "d.workspace_id")
      .select(sql<string>`count(*)::text`.as("count"))
      .where("w.account_id", "=", accountId)
      .executeTakeFirst();
    const documentCount = Number(documents?.count ?? "0");
    if (!includeReservations) {
      return documentCount;
    }

    const reservations = await db
      .selectFrom("ee_usage_limit_document_reservations")
      .select(sql<string>`count(*)::text`.as("count"))
      .where("account_id", "=", accountId)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();

    return documentCount + Number(reservations?.count ?? "0");
  }

  private async isExistingInlineExternalDocument(input: {
    workspaceId: string;
    sourceKind: string;
    externalDocumentId?: string | null;
  }): Promise<boolean> {
    if (input.sourceKind !== "inline_text" || !input.externalDocumentId) {
      return false;
    }

    const row = await this.db
      .selectFrom("documents")
      .select("id")
      .where("workspace_id", "=", input.workspaceId)
      .where("external_document_id", "=", input.externalDocumentId)
      .where("source_kind", "=", "inline_text")
      .limit(1)
      .executeTakeFirst();

    return row !== undefined;
  }

  private async releaseDocumentReservation(reservationId: string): Promise<void> {
    await this.db
      .deleteFrom("ee_usage_limit_document_reservations")
      .where("id", "=", reservationId)
      .execute();
  }
}

const noopReservation: UsageLimitReservation = {
  async commit() {},
  async release() {},
};

export const normalizePeriodStart = (value: string | undefined): string => {
  if (!value) {
    return currentPeriodStart();
  }

  const date = new Date(`${value}-01T00:00:00.000Z`);
  return toIsoDate(date);
};
