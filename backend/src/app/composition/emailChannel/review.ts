import { randomUUID } from "node:crypto";

import {
  createPostCommitInvalidationReceipt,
  flushPostCommitInvalidationReceipt,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";
import type { Kysely } from "kysely";

import { ChunkPassageRepository } from "../../../db/repositories/chunkPassageRepository.js";
import { ConversationOwnershipRepository } from "../../../db/repositories/conversationOwnershipRepository.js";
import { HeldReplyRepository } from "../../../db/repositories/heldReplyRepository.js";
import { MessageRepository } from "../../../db/repositories/messageRepository.js";
import {
  createEmailChannelConnector,
  createEmailReviewChecks,
  type EmailReviewChecks,
  type EmailReviewInferenceFactory,
} from "../../../modules/connectors/plugins/index.js";
import { reviewDraftRetrievedChunkIds } from "../../../modules/connectors/services/public.js";
import type { ConversationActivityRecorder } from "../../../modules/conversationActivity/contracts/index.js";
import {
  EMAIL_MAILBOX_POLICY_REF_PREFIX,
  EmailDomainRepository,
  EmailHeldReplyChannelScope,
  EmailMailboxRepository,
  EmailSendIntentRepository,
  EmailThreadRepository,
} from "../../../modules/emailChannel/public.js";
import {
  isHumanOwned,
  ownershipVersionOf,
  type ConversationOwnershipService,
  type HeldReplyService,
} from "../../../modules/handoff/public.js";
import type { DB } from "../../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { HeldReplyChannelRegistration } from "../heldReplyUnitOfWork.js";

/**
 * Whether email's held-reply scope grants automatic sending, and the provider a materialized send's
 * intent records. Granted only where the deployment runs `auto`.
 */
type EmailHeldReplyAutoSend = { autoSend: false } | { autoSend: true; provider: string };

/**
 * Email's side of held-reply transactions (research B1, B9): drafts bound to a mailbox's policy,
 * locked and sent through the transaction's repositories. With automatic sending granted, also the
 * thread's send budget, the queued send, its authorization at dispatch, and the send intent a
 * materialization records.
 */
export const createEmailHeldReplyChannelRegistration = (input: EmailHeldReplyAutoSend): HeldReplyChannelRegistration => ({
  policyRefPrefix: EMAIL_MAILBOX_POLICY_REF_PREFIX,
  bind: (trx) => new EmailHeldReplyChannelScope({
    mailboxes: new EmailMailboxRepository(trx),
    domains: new EmailDomainRepository(trx),
    autoSend: input.autoSend
      ? {
          threads: new EmailThreadRepository(trx),
          ownership: new ConversationOwnershipRepository(trx),
          intents: new EmailSendIntentRepository(trx),
          provider: input.provider,
          createId: randomUUID,
        }
      : undefined,
  }),
});

/**
 * The review's model checks (reply triage, completeness) over the conversation's stored messages
 * and the passages a draft drew on.
 */
export const createEmailReviewChecksOverPostgres = (deps: {
  db: Kysely<DB>;
  inference: EmailReviewInferenceFactory;
  metrics: MetricsRegistry | null;
  logger: AppLogger;
}): EmailReviewChecks => {
  const chunkPassages = new ChunkPassageRepository(deps.db);
  return createEmailReviewChecks({
    inference: deps.inference,
    messages: new MessageRepository(deps.db),
    grounding: {
      passagesFor: async ({ workspaceId, draft }) =>
        (await chunkPassages.findPassages(workspaceId, reviewDraftRetrievedChunkIds(draft))).map((passage) => ({ title: passage.title, text: passage.content })),
    },
    metrics: deps.metrics,
    logger: deps.logger,
  });
};

type EmailReviewPorts = Parameters<typeof createEmailChannelConnector>[0]["review"];

/**
 * The review runner's own ports over Postgres: the conversation reads it binds a draft to, where it
 * holds or queues the draft, and the hand-off it asks for.
 */
export const createEmailReviewPorts = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  heldReplies: Pick<HeldReplyService, "hold" | "queueAuto" | "findByReviewRef">;
  ownership: Pick<ConversationOwnershipService, "requestHumanOwnership">;
  publisher?: WorkspaceInvalidationPublisher;
  checks: EmailReviewChecks;
  maxAttempts: number;
}): EmailReviewPorts => {
  const heldReplyRecords = new HeldReplyRepository(deps.db);
  const ownership = new ConversationOwnershipRepository(deps.db);
  return {
    conversations: {
      latestCustomerMessageId: (conversationId) => heldReplyRecords.latestCustomerMessageId(conversationId),
      ownershipVersionOf: async (conversationId) => ownershipVersionOf(await ownership.load(conversationId)),
      humanOwned: async (conversationId) => isHumanOwned(await ownership.load(conversationId)),
    },
    heldReplies: {
      hold: (hold) => deps.heldReplies.hold(hold),
      queueAuto: (queued) => deps.heldReplies.queueAuto(queued),
      findByReviewRef: (conversationId, reviewRef) => deps.heldReplies.findByReviewRef(conversationId, reviewRef),
    },
    handoffs: createPostgresReviewHandoffs(deps),
    checks: deps.checks,
    maxAttempts: deps.maxAttempts,
  };
};

/**
 * A review's hand-off to a person (research B3, B7) in its own Postgres transaction: the ownership
 * change with the activity it records, through the ownership rules, and the dashboard told once it
 * commits. Only binds; whether to hand off is the review runner's decision.
 */
const createPostgresReviewHandoffs = (deps: {
  db: Kysely<DB>;
  activity: ConversationActivityRecorder;
  ownership: Pick<ConversationOwnershipService, "requestHumanOwnership">;
  publisher?: WorkspaceInvalidationPublisher;
}) => ({
  async requestHumanOwnership(input: { workspaceId: string; conversationId: string; reason: string }): Promise<void> {
    const { changed } = await deps.db.transaction().execute((trx) => deps.ownership.requestHumanOwnership({
      ownership: new ConversationOwnershipRepository(trx),
      activity: { record: (event) => deps.activity.record(trx, event) },
    }, input));
    if (changed && deps.publisher) {
      flushPostCommitInvalidationReceipt(
        deps.publisher,
        createPostCommitInvalidationReceipt(input.workspaceId, ["conversation.ownership_changed"]),
      );
    }
  },
});
