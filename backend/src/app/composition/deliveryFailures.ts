import type { Kysely } from "kysely";

import type { ConversationActivityRecorder } from "../../modules/conversationActivity/contracts/index.js";
import {
  ConversationDeliveryFailureRepository,
  DeliveryFailures,
  type DeliveryFailureUnitOfWork,
} from "../../modules/customerReplyDelivery/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * Delivery failures over Postgres: each change commits with the activity it records, and the reads
 * serve the operator surfaces. Channel-neutral; a channel's send path binds its own recorder to the
 * transition's transaction instead.
 */
export const createPostgresDeliveryFailures = (deps: { db: Kysely<DB>; activity: ConversationActivityRecorder }): DeliveryFailures => {
  const writes: DeliveryFailureUnitOfWork = {
    run: (work) => deps.db.transaction().execute((trx) => work({
      failures: new ConversationDeliveryFailureRepository(trx),
      activity: { record: (event) => deps.activity.record(trx, event) },
    })),
  };
  return new DeliveryFailures({ writes, reads: new ConversationDeliveryFailureRepository(deps.db) });
};
