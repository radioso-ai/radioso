import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type { CopilotProposalEvidence } from "../contracts.js";
import type {
  CopilotAgentSkillsVersionPort,
  CopilotAgentVersionPort,
  CopilotReplayEvidenceRecord,
  CopilotReplayEvidenceRepositoryPort,
} from "../contracts/evalCases.js";

export interface ProposalEvidenceDependencies {
  evidence: CopilotReplayEvidenceRepositoryPort;
  agentVersion: CopilotAgentVersionPort;
  /**
   * Optional so a caller that only exercises agent-level settings need not wire it. Production
   * composition always supplies it: a skill edit persists through `agent_skills`, a table
   * `agentVersion` never reads, so without this an agent whose skill changed after a case's
   * capture would still report its evidence as fresh.
   */
  agentSkillsVersion?: CopilotAgentSkillsVersionPort;
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
  // `enabled` is optional because not every caller can state a target enabled value (see
  // assertMeasuredTheProposedChange's agent_skill handling) — when present it must match what the
  // replay measured, exactly like `config`.
  | { targetType: "agent_skill"; skillSettingsKey: string | null; config: unknown; enabled?: boolean }
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
 * The envelope a `skillSettings[key]` override actually merges onto (agentConfig.ts's
 * `{ enabled, settings }` shape), read directly from the override the operator recorded — never
 * from a reconstructed merge with the baseline, for the same reason the other checks in this file
 * stay one-sided: the point is what the override *claimed* to test, not what a full replay of the
 * merge would produce. A key the override sets outside `.settings` (the pre-fix shape) never
 * reaches `.settings` here, so it correctly reads as unmeasured rather than as a match.
 */
const skillEnvelopeOverride = (
  overrides: Record<string, unknown>,
  skillSettingsKey: string,
): { enabled: unknown; settings: Record<string, unknown> } => {
  const skillSettings = asRecord(asRecord(overrides.agentConfigOverride).skillSettings);
  const envelope = asRecord(skillSettings[skillSettingsKey]);
  return { enabled: envelope.enabled, settings: asRecord(envelope.settings) };
};

/**
 * `agentConfigOverride` keys `resolveDirectiveExclusion` (evalCaseReplayService.ts) populates
 * itself when asked to exclude a directive — the mechanism of the removal, not a confound.
 */
const DIRECTIVE_EXCLUSION_OVERRIDE_KEYS = new Set(["authoredDirectives", "excludedDirectiveIds"]);

/** Top-level override categories a directive-removal replay has no honest reason to also set. */
const CONFOUNDING_TOP_LEVEL_OVERRIDE_KEYS = [
  "modelOverride",
  "assistantInstructionsOverride",
  "retrievalSettingsOverride",
  "routineStartState",
] as const;

/**
 * Whether the recorded run measured anything besides the directive exclusion itself. A replay
 * that also swapped the model, the instructions, the retrieval settings, or a routine start state
 * measured a different configuration than "this agent with one directive removed" — a real
 * verdict, but not evidence isolating the removal's effect. `overrides` is what the replay
 * service actually ran (evalCaseReplayService.ts records it, not the model), so this cannot be
 * defeated by a caller simply not mentioning a confound.
 */
const hasConfoundingOverride = (overrides: Record<string, unknown>): boolean => {
  if (CONFOUNDING_TOP_LEVEL_OVERRIDE_KEYS.some((key) => overrides[key] !== undefined)) {
    return true;
  }
  const agentConfigOverride = asRecord(overrides.agentConfigOverride);
  return Object.keys(agentConfigOverride).some(
    (key) => !DIRECTIVE_EXCLUSION_OVERRIDE_KEYS.has(key) && agentConfigOverride[key] !== undefined,
  );
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
 * - A directive removal is the opposite claim — that the directive was absent — and `overrides`
 *   cannot prove that: it is whatever the model supplied, canonical directive serialization never
 *   carries an id, and an override that simply omits an id reads as "absent" to a naive scan even
 *   when the directive's content is still right there. `directivesExcluded` is checked instead: a
 *   list the replay service computed itself by resolving ids against the source agent's real
 *   directives, so it cannot be manufactured by an override the model wrote. Membership alone is
 *   not enough, because `excludedDirectiveIds` legitimately accepts several ids at once (an
 *   operator exploring "what if I dropped both of these") and a replay that removed A and B
 *   together measured a configuration that never existed as "remove A alone" describes — removing
 *   both can improve a metric that removing A by itself would regress. The recorded set must equal
 *   exactly the one directive being proposed for removal, not merely contain it. Even an exact-set
 *   match is not enough on its own: a replay that excluded exactly this directive but *also*
 *   swapped the model or the instructions measured a confounded configuration, so
 *   {@link hasConfoundingOverride} must find nothing else in play too.
 * - A skill's configuration is compared against the envelope a `skillSettings` override actually
 *   merges onto (`{ enabled, settings }`, mirroring agentConfig.ts's serialization), not against
 *   the raw override value: a key set outside `.settings` never reaches the tuning fields
 *   materializeAgentFromConfig reads and is silently ignored at runtime, so it must not read as
 *   measured here. `enabled` is checked the same way whenever the proposal states one.
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
    if (change.directiveId) {
      // Membership is not enough: a replay that excluded A and B together measured a
      // configuration that never existed as "remove A alone" describes, and removing both can
      // improve a metric that removing A by itself would regress. The excluded set must equal
      // exactly `{ directiveId }` — no other directive along for the ride, nothing missing.
      const excludedSet = new Set(record.directivesExcluded);
      const excludedExactlyThisDirective = excludedSet.size === 1 && excludedSet.has(change.directiveId);
      if (!excludedExactlyThisDirective) {
        throw badRequest("Replay evidence did not exclude exactly the directive being removed; replay again with excludedDirectiveIds set to only this directive's id, with no other directives excluded");
      }
      if (hasConfoundingOverride(overrides)) {
        throw badRequest("Replay evidence also measured other configuration changes alongside the directive exclusion, so it cannot isolate the removal's effect; replay again with excludedDirectiveIds as the only override");
      }
      return;
    }
    const directives = asRecord(overrides.agentConfigOverride).authoredDirectives;
    if (!Array.isArray(directives) || directives.length === 0) {
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
    const envelope = skillEnvelopeOverride(overrides, change.skillSettingsKey);
    if (!sameValue(envelope.settings, change.config)) {
      throw badRequest("Replay evidence did not measure the proposed skill configuration");
    }
    if (change.enabled !== undefined && envelope.enabled !== change.enabled) {
      throw badRequest("Replay evidence did not measure the proposed skill's enabled state");
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

  const agentUpdatedAt = await resolveEffectiveAgentUpdatedAt(dependencies, request);

  return {
    cases: evidenceIds.map((id) => projectMeasurement(byId.get(id)!, agentUpdatedAt)),
  };
};

/**
 * The freshest of an agent's own edit and any of its skills' edits. `agents.updated_at` never
 * moves when a skill is created, edited, or removed (agent_skills is a sibling table), so relying
 * on it alone would report a skill changed after a case's capture as still fresh.
 * `agentSkillsVersion` is optional (see {@link ProposalEvidenceDependencies}), so its absence
 * simply contributes no additional signal rather than failing the whole resolution.
 */
const resolveEffectiveAgentUpdatedAt = async (
  dependencies: ProposalEvidenceDependencies,
  request: ProposalEvidenceRequest,
): Promise<Date> => {
  const [agent, skillsUpdatedAt] = await Promise.all([
    dependencies.agentVersion.get(request.workspaceId, request.agentId),
    dependencies.agentSkillsVersion?.latestUpdatedAt(request.workspaceId, request.agentId) ?? Promise.resolve(null),
  ]);
  return skillsUpdatedAt && skillsUpdatedAt.getTime() > agent.updatedAt.getTime()
    ? skillsUpdatedAt
    : agent.updatedAt;
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
