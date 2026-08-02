import { CompiledQuery } from "kysely";

import { ContentPlanObservationRepository } from "../../../db/repositories/contentPlanningObservationRepository.js";
import { ContentPlanProjectionRepository } from "../../../db/repositories/contentPlanningProjectionRepository.js";
import type { ContentPlanProjectionDiscoveryPort } from "../../../modules/contentPlanning/contracts/persistence.js";
import { ObservationIntakeService } from "../../../modules/contentPlanning/services/observationIntakeService.js";
import {
  bindQualityContentPlanningSqlParam as bindParam,
  buildQualityContentPlanningPopulationSql,
} from "../../../modules/quality/public.js";
import { serializeQualityDate } from "../../../modules/quality/turnReadModel.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

const MAX_SNAPSHOT_PAGE_SIZE = 500;

type SnapshotPageRow = {
  assistant_message_id: string;
  user_message_id: string | null;
  conversation_id: string;
  agent_id: string | null;
  source_channel: string | null;
  created_at: Date | string;
};

/**
 * Cross-module transaction adapter: historical turn intake and its replay cursor
 * either become durable together or both roll back. It performs no provider work.
 */
export class PostgresContentPlanProjectionDiscovery
implements ContentPlanProjectionDiscoveryPort {
  constructor(private readonly db: Db) {}

  async capturePopulationSnapshot(
    input: Parameters<ContentPlanProjectionDiscoveryPort["capturePopulationSnapshot"]>[0],
  ): ReturnType<ContentPlanProjectionDiscoveryPort["capturePopulationSnapshot"]> {
    return this.db.transaction().execute(async (trx) => {
      const state = await trx
        .selectFrom("content_plan_projection_states")
        .select([
          "target_generation_id",
          "bootstrap_processed",
          "bootstrap_total",
          "lease_token",
        ])
        .where("workspace_id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !state
        || state.target_generation_id !== input.generationId
        || state.lease_token !== input.leaseToken
      ) return null;
      if (state.bootstrap_processed !== null || state.bootstrap_total !== null) {
        if (state.bootstrap_processed === null || state.bootstrap_total === null) {
          throw new Error("Content planning population snapshot progress is inconsistent");
        }
        await releaseLease(trx, input.workspaceId, input.leaseToken);
        return { total: safeCount(state.bootstrap_total) };
      }

      const params: unknown[] = [];
      const population = buildQualityContentPlanningPopulationSql({
        workspaceId: input.workspaceId,
        window: input.window,
      }, params);
      const generationParam = bindParam(params, input.generationId);
      await trx.executeQuery(CompiledQuery.raw(
        `INSERT INTO content_plan_projection_population_snapshots (
           workspace_id, generation_id, assistant_message_id, created_at
         )
         SELECT m.workspace_id, ${generationParam}::uuid, m.id, m.created_at
         ${population.source}
         WHERE ${population.filters.join("\n           AND ")}
         ON CONFLICT (workspace_id, generation_id, assistant_message_id) DO NOTHING`,
        params,
      ));
      const count = await trx
        .selectFrom("content_plan_projection_population_snapshots")
        .select((eb) => eb.fn.countAll<string>().as("total"))
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId)
        .executeTakeFirstOrThrow();
      const total = safeCount(count.total);
      const initialized = await trx
        .updateTable("content_plan_projection_states")
        .set({
          bootstrap_processed: "0",
          bootstrap_total: String(total),
          lease_token: null,
          lease_expires_at: null,
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("target_generation_id", "=", input.generationId)
        .where("lease_token", "=", input.leaseToken)
        .where("bootstrap_processed", "is", null)
        .where("bootstrap_total", "is", null)
        .executeTakeFirst();
      if (Number(initialized.numUpdatedRows) !== 1) {
        throw new Error("Content planning population snapshot initialization was rejected");
      }
      return { total };
    });
  }

  async listPopulationSnapshotPage(
    input: Parameters<ContentPlanProjectionDiscoveryPort["listPopulationSnapshotPage"]>[0],
  ): ReturnType<ContentPlanProjectionDiscoveryPort["listPopulationSnapshotPage"]> {
    const limit = input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_PAGE_SIZE) {
      throw new RangeError(`Content planning snapshot page limit must be between 1 and ${MAX_SNAPSHOT_PAGE_SIZE}`);
    }
    if (input.cursor && (
      input.cursor.windowFrom !== input.window.from
      || input.cursor.windowTo !== input.window.to
    )) {
      throw new Error("Content planning snapshot cursor window mismatch");
    }
    let query = this.db
      .selectFrom("content_plan_projection_population_snapshots as snapshot")
      .innerJoin("messages as assistant", (join) => join
        .onRef("assistant.workspace_id", "=", "snapshot.workspace_id")
        .onRef("assistant.id", "=", "snapshot.assistant_message_id"))
      .innerJoin("conversations as conversation", (join) => join
        .onRef("conversation.workspace_id", "=", "assistant.workspace_id")
        .onRef("conversation.id", "=", "assistant.conversation_id"))
      .select([
        "assistant.id as assistant_message_id",
        "assistant.conversation_id",
        "conversation.agent_id",
        "conversation.source_channel",
        "snapshot.created_at",
      ])
      .select((eb) => eb
        .selectFrom("messages as source_user")
        .select("source_user.id")
        .whereRef("source_user.workspace_id", "=", "assistant.workspace_id")
        .whereRef("source_user.conversation_id", "=", "assistant.conversation_id")
        .where("source_user.role", "=", "user")
        .whereRef("source_user.created_at", "<=", "snapshot.created_at")
        .orderBy("source_user.created_at", "desc")
        .orderBy("source_user.id", "desc")
        .limit(1)
        .as("user_message_id"))
      .where("snapshot.workspace_id", "=", input.workspaceId)
      .where("snapshot.generation_id", "=", input.generationId);
    if (input.cursor) {
      query = query.where((eb) => eb.or([
        eb("snapshot.created_at", ">", new Date(input.cursor!.createdAt)),
        eb.and([
          eb("snapshot.created_at", "=", new Date(input.cursor!.createdAt)),
          eb("snapshot.assistant_message_id", ">", input.cursor!.assistantMessageId),
        ]),
      ]));
    }
    const rows = await query
      .orderBy("snapshot.created_at", "asc")
      .orderBy("snapshot.assistant_message_id", "asc")
      .limit(limit + 1)
      .execute() as SnapshotPageRow[];
    const hasNext = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items = selected.map((row) => ({
      assistantMessageId: row.assistant_message_id,
      userMessageId: row.user_message_id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      channel: row.source_channel,
      createdAt: serializeQualityDate(row.created_at),
    }));
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasNext && last
        ? {
            createdAt: last.createdAt,
            assistantMessageId: last.assistantMessageId,
            windowFrom: input.window.from,
            windowTo: input.window.to,
          }
        : null,
    };
  }

  async reconcilePopulationSnapshotProgress(
    input: Parameters<ContentPlanProjectionDiscoveryPort["reconcilePopulationSnapshotProgress"]>[0],
  ): ReturnType<ContentPlanProjectionDiscoveryPort["reconcilePopulationSnapshotProgress"]> {
    if (!Number.isSafeInteger(input.processed) || input.processed < 0) {
      throw new RangeError("Content planning snapshot processed count is invalid");
    }
    return this.db.transaction().execute(async (trx) => {
      const state = await trx
        .selectFrom("content_plan_projection_states")
        .select(["target_generation_id", "lease_token", "discovery_created_at", "discovery_message_id"])
        .where("workspace_id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !state
        || state.target_generation_id !== input.generationId
        || state.lease_token !== input.leaseToken
      ) return null;
      let remaining = trx
        .selectFrom("content_plan_projection_population_snapshots")
        .select((eb) => eb.fn.countAll<string>().as("total"))
        .where("workspace_id", "=", input.workspaceId)
        .where("generation_id", "=", input.generationId);
      if (input.cursor) {
        remaining = remaining.where((eb) => eb.or([
          eb("created_at", ">", input.cursor!.createdAt),
          eb.and([
            eb("created_at", "=", input.cursor!.createdAt),
            eb("assistant_message_id", ">", input.cursor!.assistantMessageId),
          ]),
        ]));
      }
      const remainingRow = await remaining.executeTakeFirstOrThrow();
      const total = input.processed + safeCount(remainingRow.total);
      if (!Number.isSafeInteger(total)) {
        throw new RangeError("Content planning snapshot total exceeds safe bounds");
      }
      const updated = await trx
        .updateTable("content_plan_projection_states")
        .set({
          bootstrap_total: String(total),
          lease_token: null,
          lease_expires_at: null,
        })
        .where("workspace_id", "=", input.workspaceId)
        .where("target_generation_id", "=", input.generationId)
        .where("lease_token", "=", input.leaseToken)
        .executeTakeFirst();
      return Number(updated.numUpdatedRows) === 1 ? { processed: input.processed, total } : null;
    });
  }

  async commitPage(
    input: Parameters<ContentPlanProjectionDiscoveryPort["commitPage"]>[0],
  ): ReturnType<ContentPlanProjectionDiscoveryPort["commitPage"]> {
    if (
      !Number.isSafeInteger(input.processed)
      || !Number.isSafeInteger(input.total)
      || input.processed < 0
      || input.total < input.processed
    ) {
      throw new Error("Content planning discovery progress is invalid");
    }

    return this.db.transaction().execute(async (trx) => {
      const projections = new ContentPlanProjectionRepository(trx);
      const state = await projections.findProjectionState(input.workspaceId);
      if (
        !state
        || state.targetGenerationId !== input.generationId
        || state.leaseToken !== input.leaseToken
      ) {
        throw new Error("Content planning projection discovery lease was lost");
      }
      const observationRepository = new ContentPlanObservationRepository(trx);
      const intake = new ObservationIntakeService(
        {
          registerTurn: (turn) => observationRepository.registerTurn(turn, trx),
          findPendingContext: (pending) => observationRepository.findPendingContext(pending),
          finalizePendingContext: (pending) => observationRepository.finalizePendingContext(pending, trx),
          excludePendingContext: (pending) => observationRepository.excludePendingContext(pending, trx),
        },
        projections,
      );
      const summary = {
        acceptedCount: 0,
        duplicateCount: 0,
        excludedCount: 0,
      };
      for (const turn of input.turns) {
        const result = await intake.registerCommittedTurn({
          workspaceId: input.workspaceId,
          conversationId: turn.conversationId,
          sourceChannel: turn.sourceChannel,
          sourceUserMessageId: turn.sourceUserMessageId,
          sourceAssistantMessageId: turn.sourceAssistantMessageId,
          interaction: turn.interaction,
          semanticVectors: [],
        });
        summary.acceptedCount += result.acceptedCount + result.finalizedCount;
        summary.duplicateCount += result.duplicateCount;
        summary.excludedCount += result.excludedCount;
      }

      const advanced = await projections.advanceDiscoveryCursor({
        workspaceId: input.workspaceId,
        leaseToken: input.leaseToken,
        discoveryCreatedAt: input.cursor.createdAt,
        discoveryMessageId: input.cursor.assistantMessageId,
        bootstrapProcessed: String(input.processed),
        bootstrapTotal: String(input.total),
      });
      if (!advanced) {
        throw new Error("Content planning projection discovery cursor was rejected");
      }
      if (!await projections.releaseProjectionLease({
        workspaceId: input.workspaceId,
        leaseToken: input.leaseToken,
      })) {
        throw new Error("Content planning projection discovery lease release failed");
      }
      return summary;
    });
  }
}

const safeCount = (value: string | number | bigint): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("Content planning population count exceeds safe bounds");
  }
  return count;
};

const releaseLease = async (db: Db, workspaceId: string, leaseToken: string): Promise<void> => {
  const released = await db
    .updateTable("content_plan_projection_states")
    .set({ lease_token: null, lease_expires_at: null })
    .where("workspace_id", "=", workspaceId)
    .where("lease_token", "=", leaseToken)
    .executeTakeFirst();
  if (Number(released.numUpdatedRows) !== 1) {
    throw new Error("Content planning population snapshot lease release failed");
  }
};
