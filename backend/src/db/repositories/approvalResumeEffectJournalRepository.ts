import type { RoutineSkillResult } from "@radioso/conversation-contract";
import { currentTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db, DB } from "../../shared/infra/kysely/types.js";
import type { Kysely } from "kysely";
import {
  ApprovalResumeEffectJournalConflictError,
  type ApprovalResumeEffectDecision,
  type ApprovalResumeEffectIdentity,
  type ApprovalResumeEffectJournal,
  type ApprovalResumeEffectJournalBeginResult,
} from "../../modules/routines/approvalResumeEffectJournal.js";

const asRoutineSkillResult = (value: unknown): RoutineSkillResult => value as RoutineSkillResult;

/** Persistence adapter deliberately starts transactions on the root pool, never a decision tx. */
export class ApprovalResumeEffectJournalRepository implements ApprovalResumeEffectJournal {
  constructor(private readonly database: Kysely<DB>) {}

  async begin(input: ApprovalResumeEffectIdentity & ApprovalResumeEffectDecision): Promise<ApprovalResumeEffectJournalBeginResult> {
    return this.database.transaction().execute(async (transaction) => {
      await transaction.insertInto("approval_resume_effect_decisions").values({
        pending_decision_id: input.pendingDecisionId,
        option_id: input.optionId,
        payload_digest: input.payloadDigest,
      }).onConflict((conflict) => conflict.column("pending_decision_id").doNothing()).execute();
      const decision = await transaction.selectFrom("approval_resume_effect_decisions")
        .select(["option_id", "payload_digest"])
        .where("pending_decision_id", "=", input.pendingDecisionId)
        .executeTakeFirstOrThrow();
      if (decision.option_id !== input.optionId || decision.payload_digest !== input.payloadDigest) {
        throw new ApprovalResumeEffectJournalConflictError();
      }
      const existingEffect = await transaction.selectFrom("approval_resume_effects")
        .select(["status", "result"])
        .where("pending_decision_id", "=", input.pendingDecisionId)
        .where("routine_id", "=", input.routineId)
        .where("step_id", "=", input.stepId)
        .where("occurrence_ordinal", "=", input.occurrenceOrdinal)
        .where("input_digest", "=", input.inputDigest)
        .executeTakeFirst();
      if (existingEffect?.status === "completed" && existingEffect.result) {
        return { kind: "completed", result: asRoutineSkillResult(existingEffect.result) };
      }
      if (existingEffect?.status === "started") {
        return { kind: "started", recovered: true };
      }
      const inserted = await transaction.insertInto("approval_resume_effects").values({
        pending_decision_id: input.pendingDecisionId,
        routine_id: input.routineId,
        step_id: input.stepId,
        occurrence_ordinal: input.occurrenceOrdinal,
        input_digest: input.inputDigest,
        status: "started",
      }).onConflict((conflict) => conflict.columns([
        "pending_decision_id", "routine_id", "step_id", "occurrence_ordinal", "input_digest",
      ]).doNothing()).returning("pending_decision_id").executeTakeFirst();
      if (inserted) {
        return { kind: "started", recovered: false };
      }
      const racedEffect = await transaction.selectFrom("approval_resume_effects")
        .select(["status", "result"])
        .where("pending_decision_id", "=", input.pendingDecisionId)
        .where("routine_id", "=", input.routineId)
        .where("step_id", "=", input.stepId)
        .where("occurrence_ordinal", "=", input.occurrenceOrdinal)
        .where("input_digest", "=", input.inputDigest)
        .executeTakeFirstOrThrow();
      if (racedEffect.status === "completed" && racedEffect.result) {
        return { kind: "completed", result: asRoutineSkillResult(racedEffect.result) };
      }
      return { kind: "started", recovered: true };
    });
  }

  async complete(input: ApprovalResumeEffectIdentity & { result: RoutineSkillResult }): Promise<void> {
    await this.database.updateTable("approval_resume_effects").set({
      status: "completed",
      result: toJsonb(input.result),
      completed_at: currentTimestamp(),
      updated_at: currentTimestamp(),
    }).where("pending_decision_id", "=", input.pendingDecisionId)
      .where("routine_id", "=", input.routineId)
      .where("step_id", "=", input.stepId)
      .where("occurrence_ordinal", "=", input.occurrenceOrdinal)
      .where("input_digest", "=", input.inputDigest)
      .execute();
  }

  async assertDecision(input: ApprovalResumeEffectDecision): Promise<void> {
    const existing = await this.database.selectFrom("approval_resume_effect_decisions")
      .select(["option_id", "payload_digest"])
      .where("pending_decision_id", "=", input.pendingDecisionId)
      .executeTakeFirst();
    if (existing && (existing.option_id !== input.optionId || existing.payload_digest !== input.payloadDigest)) {
      throw new ApprovalResumeEffectJournalConflictError();
    }
  }

  async clearDecision(input: { pendingDecisionId: string; transaction: Db }): Promise<void> {
    await input.transaction.deleteFrom("approval_resume_effect_decisions")
      .where("pending_decision_id", "=", input.pendingDecisionId)
      .execute();
  }
}
