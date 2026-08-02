import { ContentPlanObservationRepository } from "../../../db/repositories/contentPlanningObservationRepository.js";
import { ContentPlanProjectionRepository } from "../../../db/repositories/contentPlanningProjectionRepository.js";
import type {
  CommittedAssistantTurnObservation,
  CommittedAssistantTurnObservationWriter,
} from "../../../modules/chat/services/chatTurnLifecycle.js";
import { ObservationIntakeService } from "../../../modules/contentPlanning/services/observationIntakeService.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * Application-owned bridge from Chat's neutral committed-turn envelope to Content
 * Planning. Repositories are transaction-bound on every call so the assistant
 * message, interaction metadata, observation, and reusable vector commit together.
 */
export class ContentPlanningCommittedTurnWriter
implements CommittedAssistantTurnObservationWriter {
  async write(input: CommittedAssistantTurnObservation, transaction: Db): Promise<void> {
    const service = new ObservationIntakeService(
      new ContentPlanObservationRepository(transaction),
      new ContentPlanProjectionRepository(transaction),
    );
    await service.registerCommittedTurn(input);
  }
}
