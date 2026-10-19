import type { Kysely } from "kysely";

import { ActionRequestExporter } from "../../db/repositories/actionRequestRepository.js";
import { ContextVariableValueExporter } from "../../db/repositories/contextVariableRepository.js";
import { ConversationSummaryExporter } from "../../db/repositories/conversationSummaryRepository.js";
import {
  AnswerFeedbackExporter,
  DataSubjectConversationRepository,
} from "../../db/repositories/dataSubjectConversationRepository.js";
import { RoutineValueExporter } from "../../db/repositories/routineStateRepository.js";
import { SlackUserIdentityFinder } from "../../modules/connectors/plugins/index.js";
import { EmailMessageExporter, EmailSenderIdentityFinder } from "../../modules/emailChannel/public.js";
import type { DataSubjectReadUnitOfWork } from "../../modules/privacy/public.js";
import { VisitorRecordExporter, WebVisitorIdentityFinder } from "../../modules/visitors/composition.js";
import type { DataSubjectDataExporter, DataSubjectIdentityFinder } from "../../shared/domain/dataSubjectAccess.js";
import type { DB, Db } from "../../shared/infra/kysely/types.js";

/** An owning module's finder or exporter, bound to the read that runs it. */
type DataSubjectIdentityFinderBinding = (trx: Db) => DataSubjectIdentityFinder;
type DataSubjectDataExporterBinding = (trx: Db) => DataSubjectDataExporter;

/** Every module's identities a data subject can be found by: one finder per identity kind. */
export const defaultDataSubjectIdentityFinders: readonly DataSubjectIdentityFinderBinding[] = [
  (trx) => new WebVisitorIdentityFinder(trx),
  (trx) => new EmailSenderIdentityFinder(trx),
  (trx) => new SlackUserIdentityFinder(trx),
];

/**
 * Every module's section of a data subject's export. A table that holds conversation or visitor
 * data needs a section here or a stated reason in the schema contract test
 * (`tests/integration/data-subject-export-coverage.integration.test.ts`).
 */
export const defaultDataSubjectDataExporters: readonly DataSubjectDataExporterBinding[] = [
  (trx) => new DataSubjectConversationRepository(trx),
  (trx) => new VisitorRecordExporter(trx),
  (trx) => new RoutineValueExporter(trx),
  (trx) => new ActionRequestExporter(trx),
  (trx) => new ConversationSummaryExporter(trx),
  (trx) => new ContextVariableValueExporter(trx),
  (trx) => new EmailMessageExporter(trx),
  (trx) => new AnswerFeedbackExporter(trx),
];

/**
 * Runs one read of a data subject's data in one read-only, repeatable-read transaction, so the
 * identities' reach and every section of an export come from the same snapshot.
 */
export const createPostgresDataSubjectReadUnitOfWork = (deps: {
  db: Kysely<DB>;
  finders?: readonly DataSubjectIdentityFinderBinding[];
  exporters?: readonly DataSubjectDataExporterBinding[];
}): DataSubjectReadUnitOfWork => {
  const finders = deps.finders ?? defaultDataSubjectIdentityFinders;
  const exporters = deps.exporters ?? defaultDataSubjectDataExporters;
  return {
    run: (work) => deps.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute((trx) => work({
        finders: finders.map((bind) => bind(trx)),
        exporters: exporters.map((bind) => bind(trx)),
        conversations: new DataSubjectConversationRepository(trx),
      })),
  };
};
