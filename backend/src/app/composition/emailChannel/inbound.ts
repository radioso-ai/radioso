import type { Kysely } from "kysely";

import { ActionRequestRepository } from "../../../db/repositories/actionRequestRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import { ConversationRepository } from "../../../db/repositories/conversationRepository.js";
import { HeldReplyRepository } from "../../../db/repositories/heldReplyRepository.js";
import type { EmailThreadProtocolUnitOfWork } from "../../../modules/connectors/plugins/index.js";
import type { ConversationActivityRecorder } from "../../../modules/conversationActivity/contracts/index.js";
import {
  EmailBacklogRepository,
  EmailChannelSweep,
  EmailInboundRepository,
  EmailThreadRepository,
  lockThreadResolution,
  type SendingDomainService,
  type SendReconciler,
} from "../../../modules/emailChannel/public.js";
import { readConversationOwnershipState, type HeldReplyService } from "../../../modules/handoff/public.js";
import type { DB } from "../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

/**
 * Binds one step of the thread protocol (research B15) to one Postgres transaction: the
 * resolution lock, the reservation log, the thread index, the conversation reads and the
 * activity it records. Only binds; what is read and written is the processor's decision.
 */
export const createPostgresThreadProtocolUnitOfWork = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
}): EmailThreadProtocolUnitOfWork => ({
  run: (work) => deps.db.transaction().execute((trx) => work({
    lockThread: (input) => lockThreadResolution(trx, input),
    inbound: new EmailInboundRepository(trx),
    threads: new EmailThreadRepository(trx),
    conversations: {
      ownershipOf: (input) => readConversationOwnershipState({
        conversations: new ConversationRepository(trx),
        ownership: new ConversationOwnershipRepository(trx),
      }, input),
    },
    activity: { record: (event) => deps.activity.record(trx, event) },
  })),
});

/**
 * The channel's sweep over Postgres: retention, domain readiness, send reconciliation, queued
 * automatic sends whose dispatch gave up, and the backlog gauges when metrics are on. Without
 * automatic sending, it also hands queued sends back to a teammate.
 */
export const createEmailChannelSweepOverPostgres = (deps: {
  db: Kysely<DB>;
  inbound: EmailInboundRepository;
  sendingDomains: SendingDomainService;
  reconciler: SendReconciler;
  heldReplies: Pick<HeldReplyService, "materializeAuto" | "returnAbandonedAuto">;
  autoSend: boolean;
  eventRetentionDays: number;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
  clock: () => Date;
}): EmailChannelSweep => {
  const heldReplyRecords = new HeldReplyRepository(deps.db);
  return new EmailChannelSweep({
    inbound: deps.inbound,
    domains: deps.sendingDomains,
    sends: deps.reconciler,
    clock: deps.clock,
    logger: deps.logger,
    config: { eventRetentionDays: deps.eventRetentionDays },
    abandonedAutoSends: {
      queued: heldReplyRecords,
      outbox: new ActionRequestRepository(deps.db),
      dispatch: { returnAbandonedAuto: (heldReplyId) => deps.heldReplies.returnAbandonedAuto(heldReplyId) },
    },
    queuedAutoRollback: deps.autoSend
      ? undefined
      : { queued: heldReplyRecords, dispatch: { materializeAuto: (heldReplyId) => deps.heldReplies.materializeAuto(heldReplyId) } },
    backlog: deps.metrics ? { reader: new EmailBacklogRepository(deps.db), metrics: deps.metrics } : undefined,
  });
};
