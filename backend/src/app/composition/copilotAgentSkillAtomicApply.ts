import { AgentSkillRepository } from "../../modules/agentSkills/repository.js";
import type { AgentSkillMcpApplyPort } from "../../modules/operatorCopilot/proposalAdapters.js";
import { CopilotRepository } from "../../db/repositories/copilotRepository.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { conflict } from "../../shared/domain/errors.js";

/**
 * Composition-only unit of work. AgentSkills keeps its validation and draft projection rules;
 * the Copilot repository keeps receipt semantics. This is the one place that makes them atomic.
 */
export const createAgentSkillMcpApplyPort = (db: Db): AgentSkillMcpApplyPort => ({
  async apply(input) {
    if (db.isTransaction) return applyOn(db, input);
    return db.transaction().execute((trx) => applyOn(trx, input));
  },
});

const applyOn = async (
  db: Db,
  input: Parameters<AgentSkillMcpApplyPort["apply"]>[0],
): Promise<{ readonly appliedRef: { readonly agentId: string; readonly skillId: string } }> => {
  const updated = await new AgentSkillRepository(db).update(input.workspaceId, input.agentId, input.skillId, {
    targetType: input.target.kind,
    targetId: input.target.id,
    replaceConfig: input.config,
    invocationMode: input.invocationMode,
    enabled: input.enabled,
    expectedUpdatedAt: input.expectedUpdatedAt,
  });
  // A domain conflict, so the reviewed executor settles the proposal stale instead of uncertain.
  if (!updated) throw conflict("Skill was updated by another writer; reload before saving again");
  const appliedRef = { agentId: input.agentId, skillId: updated.id };
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
  return { appliedRef };
};
