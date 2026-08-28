import { badRequest, notFound } from "../../../shared/domain/errors.js";
import { canonicalRetrieveAnswerSkillConfig, effectiveRetrieveAnswerSkillSettings, mergeRetrieveAnswerSkillEnvelope } from "../../agents/public.js";
import type { CopilotProposalEvidence } from "../contracts.js";
import type {
  CopilotAgentSkillConfigPort,
  CopilotAgentVersionPort,
  CopilotEvalCaseReaderPort,
  CopilotReplayEvidenceRecord,
  CopilotReplayEvidenceRepositoryPort,
  CopilotSkillConfigEnvelope,
} from "../contracts/evalCases.js";

export interface ProposalEvidenceDependencies {
  evidence: CopilotReplayEvidenceRepositoryPort;
  agentVersion: CopilotAgentVersionPort;
  /**
   * Both optional so a caller that never exercises an `agent_skill` proposal need not wire them.
   * Production composition always supplies both: an `agent_skill` proposal's staleness is decided
   * by comparing the skill's *live* stored config (`agentSkillConfig`) against what the cited
   * case's snapshot captured (`cases`) — not by `agentVersion`, since a skill edit persists through
   * `agent_skills`, a table that port never reads. See `resolveAgentSkillDrift` below.
   */
  agentSkillConfig?: CopilotAgentSkillConfigPort;
  cases?: CopilotEvalCaseReaderPort;
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
  | {
      targetType: "agent_skill";
      skillSettingsKey: string | null;
      config: unknown;
      enabled?: boolean;
      /**
       * True when this proposal has no existing skill to update — applying it would create the
       * retrieve default-answer skill's first `agent_skills` row. `agentRepository`'s sync only
       * `updateTable(...)`s an existing row, it never inserts one, so a brand-new agent has no
       * row at all even though every case snapshot still synthesises *some* `retrieval.answer`
       * envelope from the agent's own columns. See `skillConfigDriftedSinceCapture`: without this,
       * a missing live row always read as "deleted since capture", so evidence for creating the
       * first skill was permanently unusable. Absent/false for an update proposal, which *does*
       * expect a live row to still exist.
       */
      createsNewSkill?: boolean;
    }
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
): CopilotSkillConfigEnvelope => {
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
 * - A skill's configuration is compared against the *canonical* configuration the envelope a
 *   `skillSettings` override actually merges onto (`{ enabled, settings }`, mirroring
 *   agentConfig.ts's serialization) materializes to — not against the raw override value, and not
 *   against the proposal's raw `config` either. Byte-comparing the two raw shapes is not sound: a
 *   `.settings` blob that mirrors the proposal's own field names (flat `sourceScope`/`instruction`)
 *   used to byte-match and read as measured, even though `materializeAgentFromConfig` only reads
 *   `sourceScope` from nested under `__agentRetrievalDefaults` and the skill's own instruction
 *   field is `customInstruction`, not `instruction` — the replay actually ran with the baseline's
 *   values for both, unchanged. The override is also often *partial* — `agentConfigOverride` is
 *   "merged key by key onto the captured settings" — so a field the replay never touched (an
 *   untouched `sourceScope`, an untouched `enabled`) means "ran with whatever the cited case's
 *   snapshot captured", never a schema default: canonicalizing the raw override in isolation used
 *   to default an omitted `sourceScope` to `"all"` and let a proposal stating `"all"` byte-match a
 *   replay that actually measured `selected` sources, unchanged. `mergeRetrieveAnswerSkillEnvelope`
 *   (agentConfig.ts) reconstructs what the replay actually merged onto — the cited case's captured
 *   `retrieval.answer` envelope (`capturedSkillByCaseId`) — using the same field-by-field deep
 *   merge `applyAgentConfigOverride` performs everywhere else, before `effectiveRetrieveAnswerSkillSettings`
 *   and `canonicalRetrieveAnswerSkillConfig` (agentConfig.ts) project both sides onto the same
 *   canonical shape via the real materialization path, rather than duplicating that mapping here.
 *   A key set outside `.settings` entirely never reaches the tuning fields
 *   materializeAgentFromConfig reads at all and is silently ignored at runtime, so it must not
 *   read as measured either. `enabled` is checked the same way whenever the proposal states one,
 *   also against the merged (not raw override) value.
 * - No override installs a routine, so no replay can support a routine proposal.
 * - No override installs visitor context either, so the same is true of a context variable
 *   proposal: nothing in CopilotEvalCaseReplayOverrides can put a pushed, browser, or resolver
 *   value under test.
 */
const assertMeasuredTheProposedChange = (
  record: CopilotReplayEvidenceRecord,
  change: ProposalChange,
  capturedSkillByCaseId: ReadonlyMap<string, CopilotSkillConfigEnvelope | null> | null,
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
    const overrideEnvelope = skillEnvelopeOverride(overrides, change.skillSettingsKey);
    // The replay override is deep-merged onto the cited case's captured baseline when
    // materialization runs, never onto a schema default — see mergeRetrieveAnswerSkillEnvelope's
    // doc comment. `capturedSkillByCaseId` is null when no case reader is wired at all (a caller
    // that never exercises agent_skill proposals; see ProposalEvidenceDependencies) or when this
    // record's case captured nothing, in which case there is no baseline to merge onto and the
    // override is measured as-is.
    const capturedEnvelope = capturedSkillByCaseId?.get(record.caseId) ?? null;
    const baselineEnvelope = capturedEnvelope ?? { enabled: undefined, settings: {} };
    const measuredEnvelope = mergeRetrieveAnswerSkillEnvelope(baselineEnvelope, overrideEnvelope);
    const effective = effectiveRetrieveAnswerSkillSettings(measuredEnvelope.settings);
    const canonicalProposed = canonicalRetrieveAnswerSkillConfig(asRecord(change.config));
    if (
      !sameValue(effective.sourceScope, canonicalProposed.sourceScope)
      || !sameValue(effective.settings, canonicalProposed.settings)
    ) {
      throw badRequest("Replay evidence did not measure the proposed skill configuration");
    }
    if (change.enabled !== undefined && measuredEnvelope.enabled !== change.enabled) {
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

  // Loaded once, up front, and shared by both the match check (what a cited replay's override
  // actually merged onto — see assertMeasuredTheProposedChange) and the staleness check (what the
  // live skill has since moved away from — see resolveAgentSkillDrift), so the two do not each
  // read the same cases rows separately.
  const capturedSkillByCaseId = request.change.targetType === "agent_skill"
    ? await loadSnapshotDefaultAnswerSkillByCaseId(dependencies, request.workspaceId, records)
    : null;

  for (const record of records) {
    assertMeasuredTheProposedChange(record, request.change, capturedSkillByCaseId);
  }

  const agent = await dependencies.agentVersion.get(request.workspaceId, request.agentId);
  const skillDriftByEvidenceId = request.change.targetType === "agent_skill"
    ? await resolveAgentSkillDrift(dependencies, request, records, capturedSkillByCaseId)
    : null;

  return {
    cases: evidenceIds.map((id) => {
      const record = byId.get(id)!;
      // The replay ran against the configuration the case captured, never the live one, so the
      // measurement is dated by any edit after that capture — before the replay or after it.
      // Comparing against the agent's version at replay time would miss an agent that had
      // already moved on.
      const stale = agent.updatedAt.getTime() > record.baselineCapturedAt.getTime()
        || (skillDriftByEvidenceId?.get(id) ?? false);
      return projectMeasurement(record, stale);
    }),
  };
};

/**
 * The retrieve default-answer skill's captured envelope for every case a set of cited evidence
 * records names, keyed by case id — fetched once per distinct `caseId` rather than once per
 * record, since several cited records commonly share a case (different cases can also capture the
 * agent at different times). `null` when no case reader is wired at all (see
 * {@link ProposalEvidenceDependencies}), which both the match check and the staleness check treat
 * as "no baseline for any record" rather than failing the whole resolution.
 */
const loadSnapshotDefaultAnswerSkillByCaseId = async (
  dependencies: ProposalEvidenceDependencies,
  workspaceId: string,
  records: ReadonlyArray<CopilotReplayEvidenceRecord>,
): Promise<Map<string, CopilotSkillConfigEnvelope | null> | null> => {
  if (!dependencies.cases) {
    return null;
  }
  const { cases } = dependencies;
  const caseIds = [...new Set(records.map((record) => record.caseId))];
  const entries = await Promise.all(caseIds.map(async (caseId) => {
    const evalCase = await cases.findCase(workspaceId, caseId);
    return [caseId, evalCase?.snapshotDefaultAnswerSkill ?? null] as const;
  }));
  return new Map(entries);
};

/**
 * Whether the retrieve default-answer skill's *live* configuration has moved since the config a
 * cited case's snapshot captured — the direct check an `agent_skill` proposal's evidence needs,
 * since `agents.updated_at` never moves when a skill is created, edited, or removed (agent_skills
 * is a sibling table) and so cannot answer this on its own. `agentSkillConfig` is optional (see
 * {@link ProposalEvidenceDependencies}) and `capturedSkillByCaseId` is null when no case reader was
 * wired either; either absence contributes no additional signal rather than failing the whole
 * resolution, the same fallback the deleted per-agent version signal used.
 */
const resolveAgentSkillDrift = async (
  dependencies: ProposalEvidenceDependencies,
  request: ProposalEvidenceRequest,
  records: ReadonlyArray<CopilotReplayEvidenceRecord>,
  capturedSkillByCaseId: ReadonlyMap<string, CopilotSkillConfigEnvelope | null> | null,
): Promise<Map<string, boolean> | null> => {
  if (!dependencies.agentSkillConfig || !capturedSkillByCaseId || request.change.targetType !== "agent_skill") {
    return null;
  }
  const currentSkill = await dependencies.agentSkillConfig.getDefaultAnswerSkill(request.workspaceId, request.agentId);
  const createsNewSkill = request.change.createsNewSkill ?? false;
  return new Map(records.map((record) => [
    record.id,
    skillConfigDriftedSinceCapture(currentSkill, capturedSkillByCaseId.get(record.caseId) ?? null, createsNewSkill),
  ]));
};

/**
 * A missing live skill reads as drifted only when this proposal expects one to still be there
 * (an update): a genuinely deleted skill has nothing left to vouch for the measurement with. A
 * *create* proposal (`createsNewSkill`) has no live row to compare against by design —
 * `agentRepository`'s sync only updates an existing `agent_skills` row, it never inserts one, so a
 * brand-new agent has no row at all even though the cited case's snapshot still synthesises *some*
 * `retrieval.answer` envelope from the agent's own columns (every capture does). That is not the
 * row "disappearing since capture", so it must not read as drift the way an update whose row was
 * actually deleted does. Otherwise both sides run through the same canonicalization
 * `assertMeasuredTheProposedChange` uses for the proposal-match check
 * (`canonicalRetrieveAnswerSkillConfig` for the live config, `effectiveRetrieveAnswerSkillSettings`
 * for the captured envelope's settings), so a difference in either `enabled` or the canonical
 * `sourceScope`/`settings` counts as drift.
 */
const skillConfigDriftedSinceCapture = (
  current: { enabled: boolean; config: Record<string, unknown> } | null,
  captured: CopilotSkillConfigEnvelope | null,
  createsNewSkill: boolean,
): boolean => {
  if (!current) {
    return !createsNewSkill;
  }
  const baseline = captured ?? { enabled: undefined, settings: {} };
  const currentCanonical = canonicalRetrieveAnswerSkillConfig(current.config);
  const baselineCanonical = effectiveRetrieveAnswerSkillSettings(baseline.settings);
  return current.enabled !== baseline.enabled
    || !sameValue(currentCanonical.sourceScope, baselineCanonical.sourceScope)
    || !sameValue(currentCanonical.settings, baselineCanonical.settings);
};

const projectMeasurement = (record: CopilotReplayEvidenceRecord, stale: boolean) => ({
  caseId: record.caseId,
  caseName: record.caseName,
  runId: record.runId,
  before: record.recordedStatus,
  after: record.verdict,
  stale,
});
