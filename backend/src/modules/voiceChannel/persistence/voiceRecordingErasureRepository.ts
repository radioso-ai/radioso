import { sql } from "kysely";

import { isVoiceVendor, isVoiceVendorRegion } from "../../../shared/domain/voiceVendor.js";
import { decodeCursorWithKeys, encodeCursor } from "../../../shared/domain/cursorPagination.js";
import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import {
  VOICE_RECORDING_LEFT_REASONS,
  type VoiceRecordingErasureBacklog,
  type VoiceRecordingErasureClaim,
  type VoiceRecordingErasureEntry,
  type VoiceRecordingErasureHandOff,
  type VoiceRecordingErasureItem,
  type VoiceRecordingErasureSubject,
  type VoiceRecordingGivenUp,
  type VoiceRecordingLeftAtVendor,
  type VoiceRecordingLeftReason,
  type VoiceRecordingsLeftAtVendorReader,
} from "../domain.js";
import { isEmptyScope, voiceSessionsInScope } from "./voiceSessionScope.js";

interface ItemRow {
  id: string;
  conversation_id: string | null;
  vendor_region: string;
  vendor_conversation_id: string;
  attempts: number;
  failure_reason: string | null;
}

const ITEM_COLUMNS = ["id", "conversation_id", "vendor_region", "vendor_conversation_id", "attempts", "failure_reason"] as const;

const leftReasonOf = (value: string | null): VoiceRecordingLeftReason | null =>
  value && (VOICE_RECORDING_LEFT_REASONS as readonly string[]).includes(value) ? (value as VoiceRecordingLeftReason) : null;

const entryOf = (row: ItemRow): VoiceRecordingErasureEntry => ({
  id: row.id,
  conversationId: row.conversation_id,
  vendorConversationId: row.vendor_conversation_id,
  attempts: row.attempts,
  failureReason: leftReasonOf(row.failure_reason),
});

/** Seconds from now, on the database's clock, which also decides what is due. */
const secondsFromNow = (seconds: number) => sql<Date>`now() + make_interval(secs => ${seconds})`;

/**
 * `voice_recording_erasures` and `voice_recording_erasure_items`: the recordings deletions left for
 * the vendor to delete, and each erasure's sealed vendor key. Every id in them is a plain value, so
 * they outlive the organization, workspace and conversation they name. A claim leases each row it
 * takes by moving its next ask forward, so two runs of one erasure never ask about the same
 * recording; every other write is idempotent.
 */
export class VoiceRecordingErasureRepository implements VoiceRecordingErasureBacklog, VoiceRecordingsLeftAtVendorReader {
  constructor(private readonly db: Db) {}

  async hold(handOff: VoiceRecordingErasureHandOff): Promise<{ erasureId: string; recordings: number } | null> {
    if (isEmptyScope(handOff.scope)) return null;
    const erasure = await this.db
      .insertInto("voice_recording_erasures")
      .values({
        account_id: handOff.accountId,
        workspace_id: handOff.workspaceId,
        vendor: handOff.vendor,
        sealed_api_key: handOff.credential.kind === "sealed" ? handOff.credential.sealed : null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const failureReason = handOff.credential.kind === "absent" ? handOff.credential.reason : null;
    // Straight from the sessions in one statement, however many recordings the scope holds; a
    // recording a pending row already holds (a call in two scopes of one erasure) is skipped.
    const inserted = await this.db
      .insertInto("voice_recording_erasure_items")
      .columns(["erasure_id", "conversation_id", "vendor_region", "vendor_conversation_id", "failure_reason"])
      .expression(
        voiceSessionsInScope(this.db, handOff.scope)
          .select((eb) => [
            eb.val(erasure.id).as("erasure_id"),
            "s.conversation_id",
            "s.vendor_region",
            "s.vendor_conversation_id",
            eb.val(failureReason).as("failure_reason"),
          ])
          .where("s.vendor", "=", handOff.vendor)
          .where("s.vendor_conversation_id", "is not", null)
          .where("s.vendor_region", "is not", null)
          .where((eb) => eb.not(eb.exists(
            eb.selectFrom("voice_recording_erasure_items as held")
              .select("held.id")
              .whereRef("held.vendor_conversation_id", "=", "s.vendor_conversation_id")
              .whereRef("held.vendor_region", "=", "s.vendor_region")
              .where("held.status", "=", "pending"),
          ))),
      )
      .executeTakeFirst();
    const recordings = Number(inserted.numInsertedOrUpdatedRows ?? 0);
    if (recordings === 0) {
      await this.db.deleteFrom("voice_recording_erasures").where("id", "=", erasure.id).execute();
      return null;
    }
    return { erasureId: erasure.id, recordings };
  }

  async claim(erasureId: string, claim: { limit: number; leaseSeconds: number; expireAfterSeconds: number }): Promise<VoiceRecordingErasureClaim> {
    const row = await this.readErasure(erasureId);
    if (!row) return { kind: "gone" };
    const erasure = { accountId: row.account_id, workspaceId: row.workspace_id, vendor: row.vendor, sealedCredential: row.sealed_api_key };
    const givenUp = await this.failPending(erasureId, { reason: "expired", keepLastReason: false, createdBeforeSeconds: claim.expireAfterSeconds });
    // No ask can be made: every pending recording is given up on in one write, however many.
    if (!isVoiceVendor(row.vendor)) {
      givenUp.push(...await this.failPending(erasureId, { reason: "vendor_unsupported", keepLastReason: false }));
      return { kind: "batch", erasure, items: [], givenUp };
    }
    if (row.sealed_api_key === null) {
      givenUp.push(...await this.failPending(erasureId, { reason: "credential_missing", keepLastReason: true }));
      return { kind: "batch", erasure, items: [], givenUp };
    }
    const rows = await this.db
      .updateTable("voice_recording_erasure_items")
      .set((eb) => ({ attempts: eb("attempts", "+", 1), next_attempt_at: secondsFromNow(claim.leaseSeconds), updated_at: currentTimestamp() }))
      .where("id", "in", (eb) => eb
        .selectFrom("voice_recording_erasure_items")
        .select("id")
        .where("erasure_id", "=", erasureId)
        .where("status", "=", "pending")
        .where("next_attempt_at", "<=", currentTimestamp())
        .orderBy("next_attempt_at", "asc")
        .orderBy("id", "asc")
        .limit(claim.limit)
        .forUpdate()
        .skipLocked())
      .returning(ITEM_COLUMNS)
      .execute();
    const items: VoiceRecordingErasureItem[] = [];
    for (const claimed of rows) {
      if (isVoiceVendorRegion(claimed.vendor_region)) {
        items.push({ ...entryOf(claimed), region: claimed.vendor_region });
      } else if (await this.fail(claimed.id, "vendor_unsupported")) {
        // No host to ask in a region this build does not know: given up on here, so no claim keeps returning it.
        givenUp.push({ ...entryOf(claimed), failureReason: "vendor_unsupported" });
      }
    }
    return { kind: "batch", erasure, items, givenUp };
  }

  async remove(itemId: string): Promise<void> {
    await this.db.deleteFrom("voice_recording_erasure_items").where("id", "=", itemId).execute();
  }

  async keep(itemId: string, reason: VoiceRecordingLeftReason, delaySeconds: number): Promise<void> {
    await this.db
      .updateTable("voice_recording_erasure_items")
      .set({ failure_reason: reason, next_attempt_at: secondsFromNow(delaySeconds), updated_at: currentTimestamp() })
      .where("id", "=", itemId)
      .where("status", "=", "pending")
      .execute();
  }

  async postpone(itemIds: readonly string[], delaySeconds: number): Promise<void> {
    if (itemIds.length === 0) return;
    await this.db
      .updateTable("voice_recording_erasure_items")
      .set((eb) => ({
        attempts: sql<number>`greatest(${eb.ref("attempts")} - 1, 0)`,
        next_attempt_at: secondsFromNow(delaySeconds),
        updated_at: currentTimestamp(),
      }))
      .where("id", "in", [...itemIds])
      .where("status", "=", "pending")
      .execute();
  }

  async fail(itemId: string, reason: VoiceRecordingLeftReason): Promise<boolean> {
    const changed = await this.db
      .updateTable("voice_recording_erasure_items")
      .set({ status: "failed", failure_reason: reason, failed_at: currentTimestamp(), updated_at: currentTimestamp() })
      .where("id", "=", itemId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return Number(changed.numUpdatedRows) === 1;
  }

  async release(erasureId: string): Promise<{ pending: number; nextAskAt: Date | null; dueNow: boolean }> {
    const counts = await this.db
      .selectFrom("voice_recording_erasure_items")
      .select((eb) => [
        eb.fn.countAll<string>().as("total"),
        eb.fn.countAll<string>().filterWhere("status", "=", "pending").as("pending"),
        eb.fn.min("next_attempt_at").filterWhere("status", "=", "pending").as("next_ask_at"),
        sql<boolean>`coalesce(bool_or(status = 'pending' AND next_attempt_at <= now()), false)`.as("due_now"),
      ])
      .where("erasure_id", "=", erasureId)
      .executeTakeFirstOrThrow();
    const pending = Number(counts.pending);
    if (pending === 0) await this.dropKey(erasureId, Number(counts.total));
    const nextAskAt = counts.next_ask_at === null ? null : new Date(counts.next_ask_at);
    return { pending, nextAskAt, dueNow: counts.due_now };
  }

  async failExhausted(erasureId: string, maxAsks: number): Promise<{ erasure: VoiceRecordingErasureSubject; entries: VoiceRecordingGivenUp[] } | null> {
    const row = await this.readErasure(erasureId);
    if (!row) return null;
    const entries = await this.failPending(erasureId, { reason: "drain_failed", keepLastReason: true, minAttempts: maxAsks });
    await this.release(erasureId);
    return { erasure: { accountId: row.account_id, workspaceId: row.workspace_id, vendor: row.vendor, sealedCredential: row.sealed_api_key }, entries };
  }

  async overdueErasures(overdueSeconds: number, limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom("voice_recording_erasure_items")
      .select("erasure_id")
      .distinct()
      .where("status", "=", "pending")
      .where("next_attempt_at", "<", sql<Date>`now() - make_interval(secs => ${overdueSeconds})`)
      .limit(limit)
      .execute();
    return rows.map((row) => row.erasure_id);
  }

  async listForAccount(input: { accountId: string; limit: number; cursor?: string }): Promise<{
    total: number;
    recordings: VoiceRecordingLeftAtVendor[];
    nextCursor: string | null;
  }> {
    // Keyed by when each was given up on, newest first, then by id: many rows fail in one write at
    // one instant, so the time is carried at the database's full precision.
    const after = input.cursor ? decodeCursorWithKeys(input.cursor, ["failedAt", "id"]).keys : null;
    const failedOfAccount = this.db
      .selectFrom("voice_recording_erasure_items as i")
      .innerJoin("voice_recording_erasures as e", "e.id", "i.erasure_id")
      .where("e.account_id", "=", input.accountId)
      .where("i.status", "=", "failed");
    const [rows, total] = await Promise.all([
      failedOfAccount
        .select(["i.id", "e.vendor", "e.workspace_id", "i.vendor_region", "i.vendor_conversation_id", "i.conversation_id", "i.failure_reason", "i.failed_at"])
        .select(sql<string>`i.failed_at::text`.as("failed_at_key"))
        .$if(after !== null, (qb) => qb.where((eb) => eb.or([
          eb("i.failed_at", "<", sql<Date>`${after!.failedAt}::timestamptz`),
          eb.and([eb("i.failed_at", "=", sql<Date>`${after!.failedAt}::timestamptz`), eb("i.id", ">", after!.id)]),
        ])))
        .orderBy("i.failed_at", "desc")
        .orderBy("i.id", "asc")
        .limit(input.limit + 1)
        .execute(),
      failedOfAccount.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirstOrThrow(),
    ]);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      total: Number(total.total),
      recordings: page.map((row) => ({
        vendor: row.vendor,
        vendorRegion: row.vendor_region,
        vendorConversationId: row.vendor_conversation_id,
        conversationId: row.conversation_id,
        workspaceId: row.workspace_id,
        reason: leftReasonOf(row.failure_reason) ?? "vendor_failed",
        failedAt: row.failed_at ?? new Date(0),
      })),
      nextCursor: rows.length > input.limit && last ? encodeCursor({ failedAt: last.failed_at_key, id: last.id }) : null,
    };
  }

  private readErasure(erasureId: string) {
    return this.db
      .selectFrom("voice_recording_erasures")
      .select(["account_id", "workspace_id", "vendor", "sealed_api_key"])
      .where("id", "=", erasureId)
      .executeTakeFirst();
  }

  /**
   * Gives up on the erasure's pending recordings in one write, however many: all of them, those
   * created more than `createdBeforeSeconds` ago, or those with at least `minAttempts` asks. Each
   * takes `reason`, or keeps its last one when `keepLastReason` and it has one. Returns those it changed.
   */
  private async failPending(
    erasureId: string,
    failure: { reason: VoiceRecordingLeftReason; keepLastReason: boolean; createdBeforeSeconds?: number; minAttempts?: number },
  ): Promise<VoiceRecordingGivenUp[]> {
    const rows = await this.db
      .updateTable("voice_recording_erasure_items")
      .set({
        status: "failed",
        failure_reason: failure.keepLastReason ? sql<string>`coalesce(failure_reason, ${failure.reason})` : failure.reason,
        failed_at: currentTimestamp(),
        updated_at: currentTimestamp(),
      })
      .where("erasure_id", "=", erasureId)
      .where("status", "=", "pending")
      .$if(failure.createdBeforeSeconds !== undefined, (qb) =>
        qb.where("created_at", "<", sql<Date>`now() - make_interval(secs => ${failure.createdBeforeSeconds})`))
      .$if(failure.minAttempts !== undefined, (qb) => qb.where("attempts", ">=", failure.minAttempts!))
      .returning(ITEM_COLUMNS)
      .execute();
    return rows.map((row) => ({ ...entryOf(row), failureReason: leftReasonOf(row.failure_reason) ?? failure.reason }));
  }

  /** No pending recording needs the key any more: clear it, and remove the erasure once it holds nothing at all. */
  private async dropKey(erasureId: string, total: number): Promise<void> {
    if (total === 0) {
      await this.db.deleteFrom("voice_recording_erasures").where("id", "=", erasureId).execute();
      return;
    }
    await this.db
      .updateTable("voice_recording_erasures")
      .set({ sealed_api_key: null })
      .where("id", "=", erasureId)
      .where("sealed_api_key", "is not", null)
      .execute();
  }
}
