import type { Kysely } from "kysely";

import { ActionRequestRepository, type EnqueueActionRequestInput } from "../../../db/repositories/actionRequestRepository.js";
import type { WorkspaceEventRecorder } from "../../../shared/domain/workspaceEventLog.js";
import type { DB } from "../../../shared/infra/kysely/types.js";
import { CONTACT_SEND_ACTION_TYPE } from "../services/routines/contactRoutine.js";
import { contactRequestCreatedEvent } from "../services/workspaceEventLogDrafts.js";

/**
 * The action outbox for a skill that queues its action outside the turn's transaction (a notify
 * step): a new contact request and its `contact_request.created` event commit in one transaction,
 * as they do when a turn queues one.
 */
export class ContactRequestRecordingOutbox {
  constructor(private readonly db: Kysely<DB>, private readonly events: WorkspaceEventRecorder) {}

  async enqueue(input: EnqueueActionRequestInput): Promise<{ id: string; duplicate: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const queued = await new ActionRequestRepository(trx).enqueue(input);
      if (!queued.duplicate && input.type === CONTACT_SEND_ACTION_TYPE && input.workspaceId && input.conversationId) {
        await this.events.record(trx, contactRequestCreatedEvent(
          { workspaceId: input.workspaceId, conversationId: input.conversationId },
          { id: queued.id, values: input.maskedPayload ?? input.payload },
        ));
      }
      return queued;
    });
  }
}
