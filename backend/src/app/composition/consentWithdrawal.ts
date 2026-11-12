import type { Kysely } from "kysely";

import { AnswerCoverageWithholder } from "../../db/repositories/answerCoverageRepository.js";
import { AuditEventRepository, ConversationAuditWithholder } from "../../db/repositories/auditEventRepository.js";
import { BackgroundJobRepository } from "../../db/repositories/backgroundJobRepository.js";
import { ConsentWithdrawalRepository } from "../../db/repositories/consentWithdrawalRepository.js";
import { EmailMessageWithholder } from "../../modules/emailChannel/public.js";
import { ConsentWithdrawalService, type ConsentWithdrawalUnitOfWork } from "../../modules/privacy/public.js";
import { createRoutineConsentTelemetry } from "../../modules/routines/public.js";
import { VisitorImageWithholder } from "../../modules/visitorImages/composition.js";
import type { AuditEventInput } from "../../modules/audit/contracts/index.js";
import type { MessageCopyWithholder } from "../../shared/domain/messageWithholding.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import { requestAuditMetadata } from "../../shared/observability/requestAuditContext.js";
import { runTransactionWithDeadlockRetry } from "./conversationLockOrder.js";

/** An owning module's withholder, bound to the transaction that runs it. */
type MessageCopyWithholderBinding = (trx: Db) => MessageCopyWithholder;

/**
 * Every module's copies of message text that a withheld message's own row does not hold. A module
 * that keeps a copy of a message's text, keyed by the message, needs a withholder here, or a stated
 * reason in `docs-portal/content/guides/authoring-routines.mdx` (Withdrawing a consent) for why the
 * copy stays.
 */
const defaultMessageCopyWithholders: readonly MessageCopyWithholderBinding[] = [
  (trx) => new ConversationAuditWithholder(trx),
  (trx) => new AnswerCoverageWithholder(trx),
  (trx) => new EmailMessageWithholder(trx),
  // The photos a message carried: their objects go to the deletion job in the withdrawal's transaction.
  (trx) => new VisitorImageWithholder(trx, new BackgroundJobRepository(trx)),
];

/**
 * Runs one consent withdrawal in one Postgres transaction: the record's lock, the routine state, the
 * messages and every module's copies of them, the record's withdrawal and the audit event, which
 * carries the request's credential when a workspace credential asked. A withdrawal Postgres aborts
 * as a deadlock victim runs again from the start.
 */
const createPostgresConsentWithdrawalUnitOfWork = (deps: {
  db: Kysely<DB>;
  logger: Pick<AppLogger, "warn">;
  messageCopyWithholders?: readonly MessageCopyWithholderBinding[];
}): ConsentWithdrawalUnitOfWork => {
  const withholders = deps.messageCopyWithholders ?? defaultMessageCopyWithholders;
  return {
    run: (work) => runTransactionWithDeadlockRetry(deps.db, (trx) => {
      const repository = new ConsentWithdrawalRepository(trx);
      const audit = new AuditEventRepository(trx);
      return work({
        records: {
          lock: (input) => repository.lockRecord(input),
          markWithdrawn: (input) => repository.markWithdrawn(input),
        },
        routineValues: { erase: (input) => repository.eraseRoutineValues(input) },
        messages: { withhold: (input) => repository.withholdMessages(input) },
        messageCopies: withholders.map((bind) => bind(trx)),
        audit: {
          record: async (event) => {
            await audit.create({ ...event, metadata: { ...event.metadata, ...requestAuditMetadata(event.eventType) } });
          },
        },
      });
    }, { unit: "consent_withdrawal", logger: deps.logger }),
  };
};

/** The consent withdrawal service over Postgres, reporting through the routine consent telemetry. */
export const createConsentWithdrawal = (deps: {
  db: Kysely<DB>;
  logger: Pick<AppLogger, "info" | "warn" | "error">;
  metricsRegistry: Pick<MetricsRegistry, "incrementCounter"> | null;
  auditLog: { logRecorded?(event: AuditEventInput): void };
}): ConsentWithdrawalService => new ConsentWithdrawalService({
  unitOfWork: createPostgresConsentWithdrawalUnitOfWork(deps),
  records: new ConsentWithdrawalRepository(deps.db),
  auditLog: deps.auditLog,
  telemetry: createRoutineConsentTelemetry({ logger: deps.logger, metricsRegistry: deps.metricsRegistry }),
});
