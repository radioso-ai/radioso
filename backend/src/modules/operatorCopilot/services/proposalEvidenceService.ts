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
  /** The thread the draft is being made in; a measurement belongs to the flow that produced it. */
  copilotConversationId: string;
  /** The agent the proposal changes; evidence measured on any other agent is not about it. */
  agentId: string;
  evidenceIds: ReadonlyArray<string>;
  /** What the draft changes, so a measurement of something else cannot be cited for it. */
  change: ProposalChange;
}

export type ProposalChange =
  // `directiveId` is set only for a removal proposal, where it is the honest thing a replay can
  // put under test: a configuration measured without that directive in place. A save proposal
  // (create or update) omits it, because a drafted directive never matches an override's shape.
  | { targetType: "directive"; directiveId?: string }
  | { targetType: "routine" }
  | { targetType: "agent_setting"; settingKey: string; value: unknown }
  | { targetType: "agent_skill"; skillSettingsKey: string | null; config: unknown }
  | { targetType: "context_variable" };

/**
 * Which replay override carries a given agent setting. A setting absent from this map cannot be
 * put under test by a replay at all, so no measurement can support a proposal to change it.
 */
const OVERRIDE_SLOT_BY_SETTING_KEY: Record<string, (overrides: Record<string, unknown>) => unknown> = {
  customInstruction: (overrides) => asRecord(overrides.agentConfigOverride).customInstruction,
  greetingInstruction: (overrides) => asRecord(overrides.agentConfigOverride).greetingInstruction,
  skillSettings: (overrides) => asRecord(overrides.agentConfigOverride).skillSettings,
  // The replay takes a chat model at the top level and applies it as the agent's chatModelOverride.
  chatModelOverride: (overrides) => overrides.modelOverride,
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const sameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left as object);
  const rightKeys = Object.keys(right as object);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => sameValue(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key],
  ));
};

/**
 * Rejects a measurement that is real but about something else. How exactly it can be checked
 * differs by target, because the two sides are not equally comparable:
 *
 * - An agent setting is proposed as a literal value, so the measurement must have put that exact
 *   value under test.
 * - A directive payload is drafted from prose, so it never matches the directive an override was
 *   authored with. Requiring that directives were the thing under test is the strongest honest
 *   check available; it does not prove the drafted directive is the one that was measured.
 * - No override installs a routine, so no replay can support a routine proposal.
 * - No override installs visitor context either, so the same is true of a context variable
 *   proposal: nothing in CopilotEvalCaseReplayOverrides can put a pushed, browser, or resolver
 *   value under test.
 */
const assertMeasuredTheProposedChange = (
  record: CopilotReplayEvidenceRecord,
  change: ProposalChange,
): void => {
  const overrides = asRecord(record.overrides);
  if (change.targetType === "routine") {
    throw badRequest("A replay cannot measure a routine proposal; use test_agent_turn against the draft instead");
  }
  if (change.targetType === "context_variable") {
    throw badRequest("A replay cannot measure a context variable proposal; no replay override installs visitor context");
  }
  if (change.targetType === "directive") {
    const directives = asRecord(overrides.agentConfigOverride).authoredDirectives;
    if (!Array.isArray(directives)) {
      throw badRequest("Replay evidence did not measure a configuration with directives in place");
    }
    if (change.directiveId) {
      const stillPresent = directives.some((directive) => asRecord(directive).id === change.directiveId);
      if (stillPresent) {
        throw badRequest("Replay evidence measured a configuration that still includes the directive being removed");
      }
      return;
    }
    if (directives.length === 0) {
      throw badRequest("Replay evidence did not measure a configuration with directives in place");
    }
    return;
  }
  if (change.targetType === "agent_skill") {
    // Only the retrieve capability's default-answer skill round-trips through a replay override
    // today: agentRepository syncs that one agent_skills row with the legacy skillSettings["retrieval.answer"]
    // slot (by kind + invocation_mode, not by the skill's own name), and skillSettingsResolver only
    // ever reads that one hard-coded key. Every other capability and invocation mode has no override
    // slot at all, so a replay cannot speak to it and evidence cannot be attached.
    if (!change.skillSettingsKey) {
      throw badRequest("This skill's configuration cannot be measured by a replay, so evidence cannot support it");
    }
    const skillSettings = asRecord(asRecord(overrides.agentConfigOverride).skillSettings);
    if (!sameValue(skillSettings[change.skillSettingsKey], change.config)) {
      throw badRequest("Replay evidence did not measure the proposed skill configuration");
    }
    return;
  }
  const readSlot = OVERRIDE_SLOT_BY_SETTING_KEY[change.settingKey];
  if (!readSlot) {
    throw badRequest(`The ${change.settingKey} setting cannot be measured by a replay, so evidence cannot support it`);
  }
  if (!sameValue(readSlot(overrides), change.value)) {
    throw badRequest(`Replay evidence did not measure the proposed ${change.settingKey} value`);
  }
};

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
  // The card presents the measurement as part of this proposal flow. A measurement from another
  // thread was taken under whatever was being explored there, and nothing on the card separates
  // the two.
  const otherThread = records.filter((record) => record.conversationId !== request.copilotConversationId);
  if (otherThread.length > 0) {
    throw badRequest("Replay evidence was measured in a different conversation");
  }
  for (const record of records) {
    assertMeasuredTheProposedChange(record, request.change);
  }

  const agentUpdatedAt = (await dependencies.agentVersion.get(request.workspaceId, request.agentId)).updatedAt;

  return {
    cases: evidenceIds.map((id) => projectMeasurement(byId.get(id)!, agentUpdatedAt)),
  };
};

const projectMeasurement = (record: CopilotReplayEvidenceRecord, agentUpdatedAt: Date) => ({
  caseId: record.caseId,
  caseName: record.caseName,
  runId: record.runId,
  before: record.recordedStatus,
  after: record.verdict,
  // The replay ran against the configuration the case captured, never the live one, so the
  // measurement is dated by any edit after that capture — before the replay or after it. Comparing
  // against the agent's version at replay time would miss an agent that had already moved on.
  stale: agentUpdatedAt.getTime() > record.baselineCapturedAt.getTime(),
});
