import { sql } from "kysely";

import type { ConversationDataRetentionRule } from "../../shared/domain/conversationDataRetention.js";
import { OPERATOR_TEST_SOURCE_CHANNELS } from "../../shared/domain/conversationSource.js";
import type { MessageCopyWithholder, WithheldMessages } from "../../shared/domain/messageWithholding.js";
import {
  isDocumentEventDraft,
  WORKSPACE_EVENT_RETENTION_DAYS,
  WORKSPACE_EVENT_VERSIONS,
  type DocumentEventDraft,
  type LogPosition,
  type StoredLogEvent,
  type WorkspaceEventDraft,
  type WorkspaceEventLogStore,
  type WorkspaceEventRecorder,
  type WorkspaceEventType,
} from "../../shared/domain/workspaceEventLog.js";
import {
  finishedBefore,
  jsonbFieldHasAnyKey,
  jsonbKeyText,
  jsonbStringContainsAnyValueText,
  logRowAfter,
  snapshotHorizon,
  snapshotHorizonSpan,
  toSanitizedJsonb,
} from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * Writes a conversation event in the caller's transaction. The conversation's own fields come from
 * its row in the same statement, and a conversation that history's default lists leave out
 * (operator testing, or one no longer there) yields no row: the select finds nothing to insert.
 */
const recordConversationEvent = async (db: Db, draft: Exclude<WorkspaceEventDraft, DocumentEventDraft>): Promise<void> => {
  await db
    .insertInto("workspace_events")
    .columns(["workspace_id", "type", "version", "idempotency_key", "conversation_id", "agent_id", "channel", "caller_kind", "visitor_id", "data"])
    .expression((eb) => eb
      .selectFrom("conversations")
      .select([
        "workspace_id",
        sql<string>`${draft.type}::text`.as("type"),
        sql<number>`${WORKSPACE_EVENT_VERSIONS[draft.type]}::smallint`.as("version"),
        sql<string | null>`${draft.idempotencyKey ?? null}::text`.as("idempotency_key"),
        "id",
        "agent_id",
        "source_channel",
        "caller_kind",
        "visitor_id",
        toSanitizedJsonb(draft.detail).as("data"),
      ])
      .where("id", "=", draft.conversationId)
      .where("workspace_id", "=", draft.workspaceId)
      .where("purpose", "=", "production")
      .where((where) => where.or([
        where("source_channel", "is", null),
        where("source_channel", "not in", [...OPERATOR_TEST_SOURCE_CHANNELS]),
      ])))
    .onConflict((conflict) => conflict
      .columns(["workspace_id", "idempotency_key"])
      .where("idempotency_key", "is not", null)
      .doNothing())
    .execute();
};

/**
 * Writes a document event in the caller's transaction, its `data` whole: the document's id,
 * revision, title and source from its row in the same statement, then what the type adds. A
 * document that is gone, or has moved on to a newer revision, yields no row; the newer revision
 * records its own.
 */
const recordDocumentEvent = async (db: Db, draft: DocumentEventDraft): Promise<void> => {
  await db
    .insertInto("workspace_events")
    .columns(["workspace_id", "type", "version", "idempotency_key", "data"])
    .expression((eb) => eb
      .selectFrom("documents")
      .select([
        "workspace_id",
        sql<string>`${draft.type}::text`.as("type"),
        sql<number>`${WORKSPACE_EVENT_VERSIONS[draft.type]}::smallint`.as("version"),
        sql<string>`${draft.idempotencyKey}::text`.as("idempotency_key"),
        sql<unknown>`jsonb_build_object('documentId', id, 'revision', revision, 'title', title, 'sourceKind', source_kind, 'sourceId', source_id) || ${toSanitizedJsonb(draft.detail)}`.as("data"),
      ])
      .where("id", "=", draft.documentId)
      .where("workspace_id", "=", draft.workspaceId)
      .where("revision", "=", draft.revision))
    .onConflict((conflict) => conflict
      .columns(["workspace_id", "idempotency_key"])
      .where("idempotency_key", "is not", null)
      .doNothing())
    .execute();
};

const recordWorkspaceEvent = (db: Db, draft: WorkspaceEventDraft): Promise<void> =>
  isDocumentEventDraft(draft) ? recordDocumentEvent(db, draft) : recordConversationEvent(db, draft);

/**
 * The Postgres recorder. It holds no state; application composition (`workspaceEventLog.ts`) is
 * its one owner and hands it to every module that records an event.
 */
export const postgresWorkspaceEventRecorder: WorkspaceEventRecorder = { record: recordWorkspaceEvent };

const storedEventColumns = [
  "id",
  "workspace_id",
  "type",
  "version",
  "occurred_at",
  "tx_id",
  "position",
  "conversation_id",
  "agent_id",
  "channel",
  "caller_kind",
  "visitor_id",
  "data",
] as const;

interface StoredEventRow {
  id: string;
  workspace_id: string;
  type: string;
  version: number;
  occurred_at: Date | string;
  tx_id: string;
  position: string;
  conversation_id: string | null;
  agent_id: string | null;
  channel: string | null;
  caller_kind: string | null;
  visitor_id: string | null;
  data: unknown;
}

const mapStoredEvent = (row: StoredEventRow): StoredLogEvent => ({
  id: row.id,
  workspaceId: row.workspace_id,
  type: row.type as WorkspaceEventType,
  version: row.version,
  occurredAt: new Date(row.occurred_at),
  tx: row.tx_id,
  position: row.position,
  conversationId: row.conversation_id,
  agentId: row.agent_id,
  channel: row.channel,
  callerKind: row.caller_kind,
  visitorId: row.visitor_id,
  data: row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data as Record<string, unknown> : {},
});

/** Reads a workspace's log below the snapshot horizon. */
export class WorkspaceEventLogRepository implements WorkspaceEventLogStore {
  constructor(private readonly db: Db) {}

  /**
   * One page of a workspace's events of `types`, below the horizon of one repeatable-read snapshot,
   * and that horizon: the events after `after` in (transaction, position) order, oldest first, or,
   * with no `after`, the newest `limit` events, newest first. The horizon and the rows come from the
   * same snapshot, so every event below the horizon that this read did not return is behind it.
   */
  async readPage(input: {
    workspaceId: string;
    types: readonly WorkspaceEventType[];
    after: LogPosition | null;
    limit: number;
  }): Promise<{ events: StoredLogEvent[]; horizon: string; horizonXidSpan: number }> {
    return this.db.transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute(async (trx) => {
        const snapshot = await trx
          .selectNoFrom([snapshotHorizon().as("horizon"), snapshotHorizonSpan().as("span")])
          .executeTakeFirstOrThrow();
        const horizon = snapshot.horizon;
        const horizonXidSpan = Number(snapshot.span);
        if (input.types.length === 0) {
          return { events: [], horizon, horizonXidSpan };
        }
        const direction = input.after ? "asc" : "desc";
        const rows = await trx
          .selectFrom("workspace_events")
          .select(storedEventColumns)
          .where("workspace_id", "=", input.workspaceId)
          .where("type", "in", [...input.types])
          .where((eb) => finishedBefore(eb.ref("tx_id"), horizon))
          .$if(input.after !== null, (query) => query.where((eb) => logRowAfter(eb.ref("tx_id"), eb.ref("position"), input.after!)))
          .orderBy("tx_id", direction)
          .orderBy("position", direction)
          .limit(input.limit)
          .execute();
        return { events: (rows as StoredEventRow[]).map(mapStoredEvent), horizon, horizonXidSpan };
      });
  }
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Removes events past {@link WORKSPACE_EVENT_RETENTION_DAYS}, in every workspace, by age alone. */
export class WorkspaceEventLogRetention implements ConversationDataRetentionRule {
  readonly table = "workspace_events";

  constructor(private readonly db: Db) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const cutoff = new Date(input.now.getTime() - WORKSPACE_EVENT_RETENTION_DAYS * DAY_MS);
    const deleted = await this.db
      .deleteFrom("workspace_events")
      .where("id", "in", (eb) => eb
        .selectFrom("workspace_events")
        .select("id")
        .where("occurred_at", "<", cutoff)
        .limit(input.limit)
        .forUpdate()
        .skipLocked())
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }
}

/**
 * A withdrawn consent's values leave the log (#1544). By structure first, so the events go even
 * after the routine's state, and with it the values, has expired: every `routine.completed` of a
 * routine whose consent was withdrawn, and every `contact_request.created` whose values name one of
 * its slots. Then, as the audit withholder does, any other event of the conversation that states a
 * withdrawn value.
 */
export class WorkspaceEventValueWithholder implements MessageCopyWithholder {
  readonly owner = "workspace-events";

  constructor(private readonly db: Db) {}

  async withhold(messages: WithheldMessages): Promise<number> {
    const ofConversation = () => this.db
      .deleteFrom("workspace_events")
      .where("workspace_id", "=", messages.workspaceId)
      .where("conversation_id", "=", messages.conversationId);
    let removed = 0;
    for (const { routineId, slotKeys } of messages.withdrawnRoutineSlots) {
      const runs = await ofConversation()
        .where("type", "=", "routine.completed")
        .where((eb) => eb(jsonbKeyText(eb.ref("data"), "routineId"), "=", routineId))
        .executeTakeFirst();
      removed += Number(runs.numDeletedRows);
      if (slotKeys.length > 0) {
        const requests = await ofConversation()
          .where("type", "=", "contact_request.created")
          .where((eb) => jsonbFieldHasAnyKey(eb.ref("data"), "values", slotKeys))
          .executeTakeFirst();
        removed += Number(requests.numDeletedRows);
      }
    }
    if (messages.valueTexts.length > 0) {
      const stating = await ofConversation()
        .where((eb) => jsonbStringContainsAnyValueText(eb.ref("data"), messages.valueTexts))
        .executeTakeFirst();
      removed += Number(stating.numDeletedRows);
    }
    return removed;
  }
}
