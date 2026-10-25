import { sql } from "kysely";

import { isVoiceVendor, isVoiceVendorRegion } from "../../../shared/domain/voiceVendor.js";
import { currentTimestamp } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import {
  VOICE_RECORDING_LEFT_REASONS,
  type VoiceRecordingErasureBacklog,
  type VoiceRecordingErasureBatch,
  type VoiceRecordingErasureHandOff,
  type VoiceRecordingErasureItem,
  type VoiceRecordingLeftReason,
} from "../domain.js";

interface ItemRow {
  id: string;
  conversation_id: string | null;
  vendor_region: string;
  vendor_conversation_id: string;
  attempts: number;
  failure_reason: string | null;
}

const leftReasonOf = (value: string | null): VoiceRecordingLeftReason | null =>
  value && (VOICE_RECORDING_LEFT_REASONS as readonly string[]).includes(value) ? (value as VoiceRecordingLeftReason) : null;

/** A row a vendor adapter can reach; one whose region this build no longer knows reaches none. */
const itemOf = (row: ItemRow): VoiceRecordingErasureItem | null =>
  isVoiceVendorRegion(row.vendor_region)
    ? {
      id: row.id,
      conversationId: row.conversation_id,
      region: row.vendor_region,
      vendorConversationId: row.vendor_conversation_id,
      attempts: row.attempts,
      failureReason: leftReasonOf(row.failure_reason),
    }
    : null;

/**
 * `voice_recording_erasures` and `voice_recording_erasure_items`: the recordings deletions left for
 * the vendor to delete, and each erasure's sealed vendor key. Every id in them is a plain value,
 * so they outlive the organization, workspace and conversation they name; whether each of those
 * is gone since is read when an erasure is claimed. Concurrent runs of one erasure are kept apart by
 * its job's lease; every write here is idempotent, so a run that lost its lease and finishes anyway
 * changes nothing a retry would not.
 */
export class VoiceRecordingErasureRepository implements VoiceRecordingErasureBacklog {
  constructor(private readonly db: Db) {}

  async hold(handOff: VoiceRecordingErasureHandOff): Promise<string> {
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
    if (handOff.recordings.length > 0) {
      await this.db
        .insertInto("voice_recording_erasure_items")
        .values(handOff.recordings.map((recording) => ({
          erasure_id: erasure.id,
          conversation_id: recording.conversationId,
          vendor_region: recording.region,
          vendor_conversation_id: recording.vendorConversationId,
          failure_reason: failureReason,
        })))
        .execute();
    }
    return erasure.id;
  }

  async claim(erasureId: string, limit: number): Promise<VoiceRecordingErasureBatch | null> {
    const erasure = await this.readErasure(erasureId);
    if (!erasure) return null;
    const rows = await this.db
      .updateTable("voice_recording_erasure_items")
      .set((eb) => ({ attempts: eb("attempts", "+", 1), updated_at: currentTimestamp() }))
      .where("id", "in", (eb) => eb
        .selectFrom("voice_recording_erasure_items")
        .select("id")
        .where("erasure_id", "=", erasureId)
        .where("status", "=", "pending")
        .orderBy("attempts", "asc")
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(limit)
        .forUpdate()
        .skipLocked())
      .returning(["id", "conversation_id", "vendor_region", "vendor_conversation_id", "attempts", "failure_reason"])
      .execute();
    const items = this.itemsOf(rows);
    // A region this build no longer knows has no host to ask: given up on here, so no claim keeps
    // returning it unasked.
    for (const row of rows) {
      if (!items.some((item) => item.id === row.id)) await this.fail(row.id, "vendor_failed");
    }
    return { ...erasure, items };
  }

  async remove(itemId: string): Promise<void> {
    await this.db.deleteFrom("voice_recording_erasure_items").where("id", "=", itemId).execute();
  }

  async keep(itemId: string, reason: VoiceRecordingLeftReason): Promise<void> {
    await this.db
      .updateTable("voice_recording_erasure_items")
      .set({ failure_reason: reason, updated_at: currentTimestamp() })
      .where("id", "=", itemId)
      .where("status", "=", "pending")
      .execute();
  }

  async fail(itemId: string, reason: VoiceRecordingLeftReason): Promise<void> {
    await this.db
      .updateTable("voice_recording_erasure_items")
      .set({ status: "failed", failure_reason: reason, updated_at: currentTimestamp() })
      .where("id", "=", itemId)
      .where("status", "=", "pending")
      .execute();
  }

  async release(erasureId: string): Promise<{ pending: number; neverAsked: number }> {
    const counts = await this.db
      .selectFrom("voice_recording_erasure_items")
      .select((eb) => [
        eb.fn.countAll<string>().as("total"),
        eb.fn.countAll<string>().filterWhere("status", "=", "pending").as("pending"),
        eb.fn.countAll<string>().filterWhere((inner) => inner.and([inner("status", "=", "pending"), inner("attempts", "=", 0)])).as("never_asked"),
      ])
      .where("erasure_id", "=", erasureId)
      .executeTakeFirstOrThrow();
    const pending = Number(counts.pending);
    if (pending === 0) await this.dropKey(erasureId, Number(counts.total));
    return { pending, neverAsked: Number(counts.never_asked) };
  }

  async failRemaining(erasureId: string): Promise<VoiceRecordingErasureBatch | null> {
    const erasure = await this.readErasure(erasureId);
    if (!erasure) return null;
    const rows = await this.db
      .updateTable("voice_recording_erasure_items")
      .set({
        status: "failed",
        failure_reason: sql<string>`coalesce(failure_reason, ${"drain_failed" satisfies VoiceRecordingLeftReason})`,
        updated_at: currentTimestamp(),
      })
      .where("erasure_id", "=", erasureId)
      .where("status", "=", "pending")
      .returning(["id", "conversation_id", "vendor_region", "vendor_conversation_id", "attempts", "failure_reason"])
      .execute();
    await this.release(erasureId);
    return { ...erasure, items: this.itemsOf(rows) };
  }

  /** The erasure, with whether its organization and workspace are gone since the deletion wrote it. */
  private async readErasure(erasureId: string): Promise<Omit<VoiceRecordingErasureBatch, "items"> | null> {
    const row = await this.db
      .selectFrom("voice_recording_erasures as e")
      .leftJoin("accounts as a", "a.id", "e.account_id")
      .leftJoin("workspaces as w", "w.id", "e.workspace_id")
      .select(["e.account_id", "e.workspace_id", "e.vendor", "e.sealed_api_key", "a.id as live_account_id", "w.id as live_workspace_id"])
      .where("e.id", "=", erasureId)
      .executeTakeFirst();
    if (!row || !isVoiceVendor(row.vendor)) return null;
    return {
      account: { id: row.account_id, deleted: row.live_account_id === null },
      workspace: { id: row.workspace_id, deleted: row.live_workspace_id === null },
      vendor: row.vendor,
      sealedCredential: row.sealed_api_key,
    };
  }

  private itemsOf(rows: readonly ItemRow[]): VoiceRecordingErasureItem[] {
    return rows.flatMap((row) => {
      const item = itemOf(row);
      return item ? [item] : [];
    });
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
