import { ContentPlanObservationRepository } from "../../../db/repositories/contentPlanningObservationRepository.js";
import { ContentPlanProjectionRepository } from "../../../db/repositories/contentPlanningProjectionRepository.js";
import type { ContentPlanProjectionDiscoveryPort } from "../../../modules/contentPlanning/contracts/persistence.js";
import { ObservationIntakeService } from "../../../modules/contentPlanning/services/observationIntakeService.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * Cross-module transaction adapter: historical turn intake and its replay cursor
 * either become durable together or both roll back. It performs no provider work.
 */
export class PostgresContentPlanProjectionDiscovery
implements ContentPlanProjectionDiscoveryPort {
  constructor(private readonly db: Db) {}

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
