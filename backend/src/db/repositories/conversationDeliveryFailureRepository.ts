import type { Selectable } from "kysely";

// The customer-reply delivery module owns the delivery-failure vocabulary and the store ports; this
// repository is their Postgres adapter and imports the canonical types rather than redefining them.
import type {
  DeliveryFailureReadStore,
  DeliveryFailureRecord,
  DeliveryFailureWriteStore,
} from "../../modules/customerReplyDelivery/deliveryFailures.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";

type FailureRow = Selectable<DB["conversation_delivery_failures"]>;
type ListQuery = Parameters<DeliveryFailureReadStore["listOpen"]>[1];

const mapFailure = (row: FailureRow): DeliveryFailureRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  conversationId: row.conversation_id,
  messageId: row.message_id,
  provider: row.provider,
  // The table's CHECKs hold both columns to the module's vocabulary.
  kind: row.failure_kind as DeliveryFailureRecord["kind"],
  detailCode: row.detail_code,
  openedAt: row.opened_at,
  clearedAt: row.cleared_at,
  clearedByUserId: row.cleared_by_user_id,
  clearReason: row.clear_reason as DeliveryFailureRecord["clearReason"],
});

const oldestFirst = (left: DeliveryFailureRecord, right: DeliveryFailureRecord): number =>
  left.openedAt.getTime() - right.openedAt.getTime() || left.id.localeCompare(right.id);

/**
 * `conversation_delivery_failures`: one open failure per conversation and message, enforced by the
 * partial unique index the idempotent insert names as its arbiter. Construct it on the transaction
 * of the unit of work that writes, so a failure commits with the activity it records.
 */
export class ConversationDeliveryFailureRepository implements DeliveryFailureWriteStore, DeliveryFailureReadStore {
  constructor(private readonly db: Db) {}

  async insertOpen(input: Parameters<DeliveryFailureWriteStore["insertOpen"]>[0]): Promise<DeliveryFailureRecord | null> {
    const row = await this.db
      .insertInto("conversation_delivery_failures")
      .values({
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        provider: input.provider,
        failure_kind: input.kind,
        detail_code: input.detailCode,
      })
      .onConflict((oc) => oc.columns(["conversation_id", "message_id"]).where("cleared_at", "is", null).doNothing())
      .returningAll()
      .executeTakeFirst();
    return row ? mapFailure(row) : null;
  }

  async retargetOpen(input: Parameters<DeliveryFailureWriteStore["retargetOpen"]>[0]): Promise<DeliveryFailureRecord | null> {
    const row = await this.db
      .updateTable("conversation_delivery_failures")
      .set({ failure_kind: input.kind, detail_code: input.detailCode })
      .where("conversation_id", "=", input.conversationId)
      .where("message_id", "=", input.messageId)
      .where("cleared_at", "is", null)
      .where("failure_kind", "<>", input.kind)
      .returningAll()
      .executeTakeFirst();
    return row ? mapFailure(row) : null;
  }

  async clearOpen(input: Parameters<DeliveryFailureWriteStore["clearOpen"]>[0]): Promise<DeliveryFailureRecord[]> {
    const { target } = input;
    if ("messageIds" in target && target.messageIds.length === 0) return [];
    const update = this.db
      .updateTable("conversation_delivery_failures")
      .set({ cleared_at: currentTimestamp(), clear_reason: input.reason, cleared_by_user_id: input.clearedByUserId })
      .where("cleared_at", "is", null);
    const targeted = "failureId" in target
      ? update.where("id", "=", target.failureId)
      : update.where("conversation_id", "=", target.conversationId).where("message_id", "in", [...target.messageIds]);
    const rows = await targeted.returningAll().execute();
    return rows.map(mapFailure).sort(oldestFirst);
  }

  async lockOpen(input: Parameters<DeliveryFailureWriteStore["lockOpen"]>[0]): Promise<DeliveryFailureRecord | null> {
    const row = await this.db
      .selectFrom("conversation_delivery_failures")
      .selectAll()
      .where("id", "=", input.failureId)
      .where("workspace_id", "=", input.workspaceId)
      .where("cleared_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    return row ? mapFailure(row) : null;
  }

  async acknowledgeOpen(input: Parameters<DeliveryFailureWriteStore["acknowledgeOpen"]>[0]): Promise<DeliveryFailureRecord | null> {
    const row = await this.db
      .updateTable("conversation_delivery_failures")
      .set({ cleared_at: currentTimestamp(), clear_reason: "acknowledged", cleared_by_user_id: input.userId })
      .where("id", "=", input.failureId)
      .where("workspace_id", "=", input.workspaceId)
      .where("cleared_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? mapFailure(row) : null;
  }

  async find(workspaceId: string, failureId: string): Promise<DeliveryFailureRecord | null> {
    const row = await this.db
      .selectFrom("conversation_delivery_failures")
      .selectAll()
      .where("id", "=", failureId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? mapFailure(row) : null;
  }

  listOpen(workspaceId: string, query: ListQuery): Promise<DeliveryFailureRecord[]> {
    return this.list(workspaceId, query, { includeCleared: false });
  }

  listAll(workspaceId: string, query: ListQuery): Promise<DeliveryFailureRecord[]> {
    return this.list(workspaceId, query, { includeCleared: true });
  }

  private async list(
    workspaceId: string,
    query: ListQuery,
    options: { includeCleared: boolean },
  ): Promise<DeliveryFailureRecord[]> {
    let select = this.db
      .selectFrom("conversation_delivery_failures as f")
      .selectAll("f")
      .where("f.workspace_id", "=", workspaceId);
    if (!options.includeCleared) {
      select = select.where("f.cleared_at", "is", null);
    }
    const { agentId, after } = query;
    if (agentId !== undefined) {
      select = select.where((eb) => eb.exists(
        eb.selectFrom("conversations as c")
          .select("c.id")
          .whereRef("c.id", "=", "f.conversation_id")
          .where("c.agent_id", "=", agentId),
      ));
    }
    if (after) {
      select = select.where((eb) => eb.or([
        eb("f.opened_at", "<", after.openedAt),
        eb.and([eb("f.opened_at", "=", after.openedAt), eb("f.id", "<", after.id)]),
      ]));
    }
    const rows = await select
      .orderBy("f.opened_at", "desc")
      .orderBy("f.id", "desc")
      .limit(query.limit)
      .execute();
    return rows.map(mapFailure);
  }
}
