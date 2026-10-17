import type { Kysely } from "kysely";

import { AuditEventRepository, ConversationAuditEraser } from "../../db/repositories/auditEventRepository.js";
import { AudiencePulseSnapshotEraser } from "../../db/repositories/audiencePulseSnapshotRepository.js";
import { ContextVariableValueEraser } from "../../db/repositories/contextVariableRepository.js";
import { ConversationErasureRepository } from "../../db/repositories/conversationErasureRepository.js";
import { EmailSkillActivityEraser } from "../../db/repositories/emailSkillActivityRepository.js";
import { WhatsAppMessageLogEraser } from "../../modules/connectors/plugins/index.js";
import { EmailInboundEraser } from "../../modules/emailChannel/public.js";
import { EvalConversationEraser } from "../../modules/eval/composition.js";
import type { ConversationErasureUnitOfWork } from "../../modules/privacy/public.js";
import type {
  ConversationDataEraser,
  VerifiedCustomerDataEraser,
} from "../../shared/domain/conversationDataErasure.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { requestAuditMetadata } from "../../shared/observability/requestAuditContext.js";
import { lockConversationsInOrder, runTransactionWithDeadlockRetry } from "./conversationLockOrder.js";

/** An owning module's eraser, bound to the transaction that runs it. */
type ConversationDataEraserBinding = (trx: Db) => ConversationDataEraser;
type VerifiedCustomerDataEraserBinding = (trx: Db) => VerifiedCustomerDataEraser;

/**
 * Every module's eraser for the conversation-derived rows its tables keep where no foreign key
 * reaches. A table that carries a conversation, session or visitor id needs a cascading foreign
 * key, an eraser here, or a stated reason in the schema contract test
 * (`tests/integration/conversation-erasure-coverage.integration.test.ts`).
 */
export const defaultConversationDataErasers: readonly ConversationDataEraserBinding[] = [
  (trx) => new ContextVariableValueEraser(trx),
  (trx) => new ConversationAuditEraser(trx),
  (trx) => new EmailInboundEraser(trx),
  (trx) => new EmailSkillActivityEraser(trx),
  (trx) => new EvalConversationEraser(trx),
  (trx) => new WhatsAppMessageLogEraser(trx),
  (trx) => new AudiencePulseSnapshotEraser(trx),
];

/** Every module's eraser for the rows it keys by an erased visitor's verified customer id. */
export const defaultVerifiedCustomerDataErasers: readonly VerifiedCustomerDataEraserBinding[] = [
  (trx) => new ContextVariableValueEraser(trx),
];

/**
 * Runs one erasure in one Postgres transaction: the conversation and visitor locks, every module's
 * eraser, the delete and its cascade, and the audit event, which carries the request's credential
 * when a workspace credential asked. Locks follow the conversation lock protocol
 * (`conversationLockOrder.ts`); a visitor's row is taken first, and an erasure Postgres aborts as a
 * deadlock victim runs again from the start.
 */
export const createPostgresConversationErasureUnitOfWork = (deps: {
  db: Kysely<DB>;
  logger: Pick<AppLogger, "warn">;
  conversationErasers?: readonly ConversationDataEraserBinding[];
  verifiedCustomerErasers?: readonly VerifiedCustomerDataEraserBinding[];
}): ConversationErasureUnitOfWork => {
  const conversationErasers = deps.conversationErasers ?? defaultConversationDataErasers;
  const verifiedCustomerErasers = deps.verifiedCustomerErasers ?? defaultVerifiedCustomerDataErasers;
  return {
    run: (work) => runTransactionWithDeadlockRetry(deps.db, (trx) => {
      const subjects = new ConversationErasureRepository(trx);
      const audit = new AuditEventRepository(trx);
      return work({
        subjects: {
          lockConversations: (workspaceId, conversationIds) => lockConversationsInOrder(trx, workspaceId, conversationIds),
          lockVisitor: (workspaceId, visitorId) => subjects.lockVisitor(workspaceId, visitorId),
          deleteConversations: (workspaceId, conversationIds) => subjects.deleteConversations(workspaceId, conversationIds),
          deleteVisitor: (workspaceId, visitorId) => subjects.deleteVisitor(workspaceId, visitorId),
        },
        conversationErasers: conversationErasers.map((bind) => bind(trx)),
        verifiedCustomerErasers: verifiedCustomerErasers.map((bind) => bind(trx)),
        audit: {
          record: async (event) => {
            await audit.create({ ...event, metadata: { ...event.metadata, ...requestAuditMetadata(event.eventType) } });
          },
        },
      });
    }, { unit: "conversation_erasure", logger: deps.logger }),
  };
};

/**
 * Runs every module's workspace-scope eraser for workspaces about to be deleted, inside the
 * transaction that deletes them, so rows that outlive a workspace by design (its audit events) lose
 * their conversation content first. The foreign keys take everything else.
 */
export const createWorkspaceConversationDataErasure = (
  erasers: readonly ConversationDataEraserBinding[] = defaultConversationDataErasers,
) => async (trx: Db, workspaceIds: readonly string[]): Promise<void> => {
  for (const workspaceId of workspaceIds) {
    for (const bind of erasers) {
      await bind(trx).erase({ kind: "workspace", workspaceId });
    }
  }
};
