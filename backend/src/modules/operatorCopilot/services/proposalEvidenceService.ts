import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type { CopilotProposalEvidence } from "../contracts.js";
import type {
  CopilotAgentVersionPort,
  CopilotReplayEvidenceRecord,
  CopilotReplayEvidenceRepositoryPort,
} from "../contracts/evalCases.js";

export interface ProposalEvidenceDependencies {
  evidence: CopilotReplayEvidenceRepositoryPort;
  agentVersion: CopilotAgentVersionPort;
}

export interface ProposalEvidenceRequest {
  workspaceId: string;
  operatorUserId: string;
  /** The agent the proposal changes; evidence measured on any other agent is not about it. */
  agentId: string;
  evidenceIds: ReadonlyArray<string>;
}

/**
 * Turns the ids a draft cites into the measurements the operator reviews. Nothing here trusts the
 * assistant's account of what a replay produced: the verdicts come from the rows the replay wrote.
 * Every cited id must resolve — dropping one would restate a two-case claim as a one-case claim
 * while still reading as verified.
 */
export const resolveProposalEvidence = async (
  dependencies: ProposalEvidenceDependencies,
  request: ProposalEvidenceRequest,
): Promise<CopilotProposalEvidence | null> => {
  const evidenceIds = [...new Set(request.evidenceIds)];
  if (evidenceIds.length === 0) {
    return null;
  }

  const records = await dependencies.evidence.findMany({
    workspaceId: request.workspaceId,
    operatorUserId: request.operatorUserId,
    ids: evidenceIds,
  });
  const byId = new Map(records.map((record) => [record.id, record]));
  const missing = evidenceIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw notFound(`Replay evidence not found: ${missing.join(", ")}`);
  }
  const foreign = records.filter((record) => record.agentId !== request.agentId);
  if (foreign.length > 0) {
    throw badRequest("Replay evidence was measured against a different agent");
  }

  const currentVersionToken = (await dependencies.agentVersion.get(request.workspaceId, request.agentId))
    .updatedAt.toISOString();

  return {
    cases: evidenceIds.map((id) => projectMeasurement(byId.get(id)!, currentVersionToken)),
  };
};

const projectMeasurement = (record: CopilotReplayEvidenceRecord, currentVersionToken: string) => ({
  caseId: record.caseId,
  caseName: record.caseName,
  runId: record.runId,
  before: record.recordedStatus,
  after: record.verdict,
  // The replay ran against the case's captured configuration, so what dates it is the live agent
  // moving underneath: the operator is no longer looking at the agent that was measured.
  stale: record.agentVersionToken !== currentVersionToken,
});
