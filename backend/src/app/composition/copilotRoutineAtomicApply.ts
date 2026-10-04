import { CopilotRepository } from "../../db/repositories/copilotRepository.js";
import { RoutineDefinitionRepository } from "../../db/repositories/routineDefinitionRepository.js";
import { agentRevisionLockKey } from "../../db/repositories/agentDraftMutation.js";
import type { RoutineMcpApplyPort } from "../../modules/operatorCopilot/proposalAdapters.js";
import { translateRoutineDefinitionWriteConflict, type RoutineDefinition } from "../../modules/routines/public.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { conflict } from "../../shared/domain/errors.js";
import { transactionAdvisoryLock } from "../../shared/infra/kysely/sqlHelpers.js";

/**
 * Transaction assembly, not a routine rule: both stores share this Kysely unit of work while the
 * routine repository remains unaware that a Copilot receipt exists.
 */
export const createRoutineMcpApplyPort = (db: Db, deps: {
  validateScopedReferences(input: {
    readonly workspaceId: string;
    readonly agentId: string;
    readonly routineId: string;
    readonly removedNodeIds: readonly string[];
    readonly removedSlotIds: readonly string[];
  }, db: Db): Promise<void>;
}): RoutineMcpApplyPort => ({
  async apply(input) {
    if (db.isTransaction) {
      return applyOn(db, input, deps);
    }
    return db.transaction().execute((trx) => applyOn(trx, input, deps));
  },
});

const applyOn = async (
  db: Db,
  input: Parameters<RoutineMcpApplyPort["apply"]>[0],
  deps: Parameters<typeof createRoutineMcpApplyPort>[1],
): Promise<{ readonly appliedRef: { readonly agentId: string; readonly routineId: string }; readonly routine?: RoutineDefinition }> => {
  // Directive writers and every routine draft mutation use this same lock. Acquiring it before
  // the scoped-tag read makes the check and the owner write one serializable authoring decision.
  await transactionAdvisoryLock(agentRevisionLockKey(input.workspaceId, input.agentId)).execute(db);
  const routines = new RoutineDefinitionRepository(db);
  if (input.operation === "delete") {
    await deps.validateScopedReferences({ workspaceId: input.workspaceId, agentId: input.agentId, routineId: input.routineId, removedNodeIds: input.removedNodeIds, removedSlotIds: input.removedSlotIds }, db);
    const deleted = await routines.deleteDraftWithAgentDraft(input.workspaceId, input.agentId, input.routineId, { expectedUpdatedAt: input.expectedUpdatedAt });
    // A domain conflict, so the reviewed executor settles the proposal stale instead of uncertain.
    if (deleted.outcome !== "deleted") throw conflict("Routine changed while its draft was being deleted — reload it and try again");
    const appliedRef = { agentId: input.agentId, routineId: input.routineId };
    const settled = await new CopilotRepository(db).settleMcpAppliedOn({ proposalId: input.proposalId, executionInvocationId: input.executionInvocationId, workspaceId: input.workspaceId, operatorUserId: input.operatorUserId, claimedAt: input.claimedAt, appliedRef, now: new Date() }, db);
    if (!settled) throw new Error("reviewed_proposal_receipt_conflict");
    return { appliedRef };
  }
  if (input.operation === "update") {
    await deps.validateScopedReferences({ workspaceId: input.workspaceId, agentId: input.agentId, routineId: input.routineId, removedNodeIds: input.removedNodeIds, removedSlotIds: input.removedSlotIds }, db);
  }
  let saved: RoutineDefinition;
  try {
    saved = input.operation === "create"
      ? await routines.createDraftWithAgentDraft(input.workspaceId, input.agentId, input.draft)
      : await routines.updateDraftWithAgentDraft(input.workspaceId, input.agentId, input.routineId, input.draft, { expectedUpdatedAt: input.expectedUpdatedAt });
  } catch (error) {
    // The repository raises raw write conflicts; the routine owner translates them to domain ones.
    throw translateRoutineDefinitionWriteConflict(error) ?? error;
  }
  const appliedRef = { agentId: input.agentId, routineId: saved.id };
  const settled = await new CopilotRepository(db).settleMcpAppliedOn({
    proposalId: input.proposalId,
    executionInvocationId: input.executionInvocationId,
    workspaceId: input.workspaceId,
    operatorUserId: input.operatorUserId,
    claimedAt: input.claimedAt,
    appliedRef,
    now: new Date(),
  }, db);
  if (!settled) throw new Error("reviewed_proposal_receipt_conflict");
  return { appliedRef, routine: saved };
};
