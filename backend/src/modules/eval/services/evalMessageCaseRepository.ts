import type { Kysely } from "kysely";

import {
  transactionAdvisoryLock,
} from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import type {
  EvalCaseStatus,
  EvalMessageCaseLookup,
  EvalMessageCaseMutationResult,
  EvalMessageCaseVerification,
  EvalRunStatus,
} from "../domain/types.js";
import type {
  EvalMessageCaseRepositoryPort,
  EvalSourceMessage,
  FindOrCreateEvalMessageCaseInput,
} from "./evalMessageCaseService.js";
import {
  findCase,
  findSnapshot,
  insertCase,
  insertSnapshot,
  isoDate,
} from "./evalPersistence.js";

const findMessageCaseAssociation = async (
  db: Db,
  workspaceId: string,
  assistantMessageId: string,
): Promise<EvalMessageCaseLookup | null> => {
  const association = await db
    .selectFrom("eval_message_case_associations")
    .select(["assistant_message_id", "case_id", "created_by", "created_at"])
    .where("workspace_id", "=", workspaceId)
    .where("assistant_message_id", "=", assistantMessageId)
    .limit(1)
    .executeTakeFirst();
  if (!association) {
    return null;
  }

  const evalCase = await findCase(db, workspaceId, association.case_id);
  if (!evalCase) {
    return null;
  }
  const snapshot = await findSnapshot(db, workspaceId, evalCase.snapshotId);
  if (!snapshot) {
    return null;
  }

  return {
    assistantMessageId: association.assistant_message_id,
    case: evalCase,
    snapshot,
    createdBy: association.created_by,
    createdAt: isoDate(association.created_at),
  };
};

/**
 * Owns the stable source-message association and the only transaction that
 * creates an immutable snapshot, default case, and association together.
 */
export class EvalMessageCaseRepository implements EvalMessageCaseRepositoryPort {
  constructor(private readonly db: Kysely<DB>) {}

  async findSourceMessage(
    workspaceId: string,
    assistantMessageId: string,
  ): Promise<EvalSourceMessage | null> {
    const row = await this.db
      .selectFrom("messages")
      .select(["id", "conversation_id", "role", "source", "created_at"])
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", assistantMessageId)
      .limit(1)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as EvalSourceMessage["role"],
      source: row.source,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }

  async findMessageCase(
    workspaceId: string,
    assistantMessageId: string,
  ): Promise<EvalMessageCaseLookup | null> {
    return findMessageCaseAssociation(this.db, workspaceId, assistantMessageId);
  }

  async findOrCreateMessageCase(
    input: FindOrCreateEvalMessageCaseInput,
  ): Promise<EvalMessageCaseMutationResult> {
    return this.db.transaction().execute(async (trx) => {
      await transactionAdvisoryLock(
        `eval-message-case:${input.workspaceId}:${input.assistantMessageId}`,
      ).execute(trx);

      const existing = await findMessageCaseAssociation(
        trx,
        input.workspaceId,
        input.assistantMessageId,
      );
      if (existing) {
        return { ...existing, created: false };
      }

      const snapshot = await insertSnapshot(trx, input.snapshot);
      const evalCase = await insertCase(trx, {
        workspaceId: input.workspaceId,
        snapshotId: snapshot.id,
        name: input.caseName,
        assertions: [],
      });
      const association = await trx
        .insertInto("eval_message_case_associations")
        .values({
          workspace_id: input.workspaceId,
          assistant_message_id: input.assistantMessageId,
          case_id: evalCase.id,
          created_by: input.createdBy ?? null,
        })
        .returning(["assistant_message_id", "created_by", "created_at"])
        .executeTakeFirstOrThrow();

      return {
        assistantMessageId: association.assistant_message_id,
        case: evalCase,
        snapshot,
        createdBy: association.created_by,
        createdAt: isoDate(association.created_at),
        created: true,
      };
    });
  }

  async lookupMessageCaseVerifications(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<Map<string, EvalMessageCaseVerification>> {
    if (assistantMessageIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom("eval_message_case_associations")
      .innerJoin("eval_cases", (join) =>
        join
          .onRef("eval_cases.id", "=", "eval_message_case_associations.case_id")
          .onRef(
            "eval_cases.workspace_id",
            "=",
            "eval_message_case_associations.workspace_id",
          ))
      .leftJoin("eval_runs", (join) =>
        join
          .onRef("eval_runs.id", "=", "eval_cases.last_run_id")
          .onRef("eval_runs.workspace_id", "=", "eval_cases.workspace_id"))
      .select([
        "eval_message_case_associations.assistant_message_id as assistant_message_id",
        "eval_cases.id as case_id",
        "eval_cases.status as case_status",
        "eval_runs.status as latest_run_status",
        "eval_runs.started_at as latest_run_started_at",
        "eval_runs.completed_at as latest_run_completed_at",
      ])
      .where("eval_message_case_associations.workspace_id", "=", workspaceId)
      .where(
        "eval_message_case_associations.assistant_message_id",
        "in",
        assistantMessageIds,
      )
      .execute();

    return new Map(rows.map((row) => [
      row.assistant_message_id,
      {
        caseId: row.case_id,
        caseStatus: row.case_status as EvalCaseStatus,
        latestRunStatus: row.latest_run_status as EvalRunStatus | null,
        latestRunAt: row.latest_run_completed_at
          ? isoDate(row.latest_run_completed_at)
          : row.latest_run_started_at
            ? isoDate(row.latest_run_started_at)
            : null,
      },
    ]));
  }
}
