interface FieldParityExclusion {
  readonly disposition: "deferred" | "permanent";
  readonly reason: string;
}

const deferred = (reason: string): FieldParityExclusion => ({ disposition: "deferred", reason });
const permanent = (reason: string): FieldParityExclusion => ({ disposition: "permanent", reason });
/** Applies one exclusion entry to every named field of one tool. */
const fields = (fieldNames: ReadonlyArray<string>, entry: FieldParityExclusion): Record<string, FieldParityExclusion> =>
  Object.fromEntries(fieldNames.map((fieldName) => [fieldName, entry]));

const internalDebugTraceNeverToModel = permanent(
  "includeDebug controls an internal retrieval activity trace meant for dashboard debugging (activitySummary/activityTrace, or the equivalent chat debug block). Feeding that into a model prompt is exactly the leak CLAUDE.md's observability guidance rules out, so it stays off every Ray-facing search, probe, and test-turn tool.",
);

const documentSearchUnreviewedMetadataFilter = deferred(
  "document_search takes only a free-text query; results are never narrowed by metadata before scoring. Nobody has reviewed whether Ray should be able to filter a search the way an operator can.",
);

const agentSettingGenericKeyValue = permanent(
  "propose_agent_setting changes one agent setting at a time through a generic settingKey/value pair rather than one schema field per settable property. settingKey is validated against agentInputFieldSchemas (modules/agents/agentInputSchema.ts), which covers every one of updateAgent's fields, so each is reachable by name through value rather than through a same-named top-level input field.",
);

const contextVariableEnablementNesting = permanent(
  "Carried nested one level down, under the `enablement` object, using these exact field names (proposalInputSchema in tools/contextVariables.ts) — not a capability gap, just not a top-level match.",
);

const directiveIntentDrafted = permanent(
  "propose_directive takes a free-text `intent`; directiveAdapter.draft() (proposalAdapters.ts) synthesizes the full structured directive from it server-side. Ray never supplies these fields directly, by design — the same intent-to-structured-draft pattern propose_routine and propose_agent use.",
);
const directiveEnablementLeavesFieldsAlone = permanent(
  "propose_directive_enablement only flips `enabled` on an already-authored directive. Its structured fields (name, condition, action, ...) are untouched by this call and stay whatever the stored directive already has, so they have no place on this input.",
);

const ingestionEmbeddingModelNeverList = permanent(
  "Embedding-model changes require a typed operator confirmation outside the copilot (never-list entry embedding_model_switch_without_typed_confirmation). copilotIngestionSettingsChangeSchema already refuses this field for the same reason the rest of updateIngestionSettings flows through propose_ingestion_settings.",
);

const workspaceSettingFlattensGroups = permanent(
  "propose_workspace_setting flattens the REST body's nested `assistant`/`channels` groups into top-level fields, per the tool's own description ('Name only the fields you want changed'); every nested field is reachable under its own top-level name instead.",
);

const agentWizardChunkingIsIngestionConfig = permanent(
  "The suggested chunking strategy is workspace-wide ingestion configuration rather than part of an agent, per the tool's own description; applying it is a separate propose_ingestion_settings card that would re-chunk every source in the workspace.",
);

const routineIntentDrafted = permanent(
  "propose_routine takes a free-text `intent`; routineAdapter.draft() (proposalAdapters.ts) synthesizes the whole structured routine from it server-side — the same intent-to-structured-draft pattern propose_directive uses.",
);
const routineEditFieldPatchNesting = permanent(
  "Carried nested one level down, under `changes` (routineFieldPatchSchema), using these exact field names.",
);
const routineCannotReworkBranching = deferred(
  "propose_routine_edit edits elements that already exist by stable id; it cannot add or remove a step or rework branching (routineEditDescription), the same routine-graph boundary catalogCoverage's deleteAgentRoutine entry cites.",
);
const routineEditCompletionExportUnreachable = deferred(
  "Editing an existing routine's completion-export destination has no field on this patch. Wiring a routine's completion to an operator's webhook destination waits on the same Wave 5 webhook-destination review as creating or changing the destination itself (catalogCoverage's webhookDestinationConfiguration).",
);
const routineExposureCarriedFlat = permanent(
  "Carried flat as `enabled`, `toolName`, and `description` — the three fields of the exposure block — rather than as a nested `exposure` object, because the tool transport renders a nested input object as the bare word \"object\" (routineExposureInputSchema in tools/routines.ts). `enabled` on this tool is the exposure's own switch, not the routine's; the routine's stays as stored.",
);
const routineExposureLeavesFieldsAlone = permanent(
  "propose_routine_exposure changes only the exposure block of an already-authored routine. Its wording, trigger, fields, steps, endings, branches, and completion export stay whatever the stored routine already has — the same one-concern shape propose_directive_enablement takes toward a directive.",
);
const routineStructuralPreparationNesting = permanent(
  "Carried nested: each of these is set either as an `operations[]` entry (set_enabled, insert/replace/remove_step, insert/replace/remove_slot, insert/replace/remove_terminal, insert/replace/remove_transition) or, for a brand-new routine, nested under `draft` — never as a same-named top-level field.",
);
const routineStructuralPreparationExposureViaOwnTool = permanent(
  "Reachable nested under `draft.exposure` when creating a routine; for an existing routine, exposure is one concern with its own reviewed card, propose_routine_exposure, rather than an `operations[]` entry here.",
);
const routineStructuralPreparationCompletionExportUnreachable = deferred(
  "Reachable only when creating a routine, nested under `draft.completionExport`; no `operations[]` entry updates an existing routine's completion-export destination, so editing one waits on the same Wave 5 webhook-destination review as propose_routine_edit's gap.",
);

const skillConfigAlwaysMergesNeverReplaces = permanent(
  "propose_skill_config always merges its `config` onto the skill's existing stored config (mergeSkillConfig) and applies through a full replaceConfig internally with the already-merged result (proposalAdapters.ts). Ray never performs a blind full replace of a config it has not read in full — the same reasoning catalogCoverage's documentBodyIsOperatorAuthored applies to a document body.",
);

const evalReplaySnapshotScopeUncovered = deferred(
  "replay_eval_case only reaches the case-derived, detached replay createEvalRun also supports. createEvalRun's snapshot-scoped replay (`snapshotId`, `mode`) remains the uncovered rest catalogCoverage's createEvalRun entry already tracks as deferred ('a snapshot-scoped replay tool would cover the rest').",
);
const evalReplayAgentConfigOverrideNarrowed = permanent(
  "Carried nested under `overrides.agentConfigOverride`, deliberately narrowed to the behavior-bearing fields only (see the comment on replayOverridesSchema): logo, theme, and branding never move a verdict, so offering them would only invite spending a replay on a cosmetic difference.",
);

const evalSuiteNeverLiveEffects = permanent(
  "Ray may replay and evaluate a case, but never enables the live external effects a run can invoke — the same never-list boundary catalogCoverage's liveEvalEffects entry states for setEvalCaseExecutionMode. run_eval_suite always runs with live effects off.",
);

const triageReasonIsDeprecatedCompat = permanent(
  "`reason` is a deprecated, compatibility-only free-text field on the REST body ('never classified as a structured resolution reason', SetQualityTriageRequestSchema). set_triage_state only ever carries the structured `resolution.reason` enum it already exposes.",
);

const turnProbeAlwaysTestsAMessage = permanent(
  "test_agent_turn always tests a message turn (`message` is required, never optional). The proactive-greeting bootstrap flow (`startConversation`/`bootstrapGreetingId`; 'message is required unless startConversation is true') has nothing for this probe to test.",
);
const turnProbeNoTransportChoice = permanent(
  "`stream` selects SSE vs JSON HTTP delivery. An operator-copilot tool call returns one structured result and has no transport-level streaming choice to make.",
);
const turnProbeNoLiveChannel = permanent(
  "sourceContext identifies which real customer-facing surface (authenticated_chat/public_chat/website_embed) sent the message, for visitor-context directive matching. test_agent_turn is a copilot-run synthetic probe, not a live customer channel, so it has no surface to report.",
);
const turnProbeUnreviewedMetadataFilter = deferred(
  "test_agent_turn does not yet let Ray scope a test turn's retrieval to a metadata filter. Nobody has reviewed whether that belongs on this probe, the same open question document_search's metadataFilter gap carries.",
);

const publicationFenceIsReadFresh = permanent(
  "prepare_agent_publication reads the agent's current draft generation itself immediately before creating the candidate and supplies it as the optimistic-concurrency fence. Asking Ray to track and resupply its own expectedDraftGeneration would only reproduce a value it could already get stale.",
);

const testChatDraftFenceIsReadFresh = permanent(
  "send_test_chat_message reads the agent's draft generation itself immediately before it creates the candidate and starts the session, and supplies it as both fences, the same way prepare_agent_publication does. A caller resupplying its own copy could only hand back a staler value.",
);
const testChatRunsOneRevision = permanent(
  "Carried as the singular `revisionId`: every session send_test_chat_message starts runs one revision, so the one-element `revisionIds` array is built from it.",
);
const testChatComparisonUnreachable = deferred(
  "send_test_chat_message starts and continues single-revision sessions only. A comparison (`mode: \"compare\"`, two revisions answering one message) is readable through test_chat_transcript but starts and continues in the dashboard until comparison has a reviewed transport shape.",
);
const testChatSampleValuesUnreachable = deferred(
  "send_test_chat_message starts a session without context-variable sample values. Supplying `testValues` waits on a review of how an operator-supplied, possibly sensitive sample value travels through a model-facing tool.",
);
const testChatSeedUnreachable = deferred(
  "Starting a session from an existing conversation's thread (`seedConversationId`) stays in the dashboard's Continue in Test Chat until that handoff has its own reviewed tool shape.",
);
const testChatMintsItsOwnIdentities = permanent(
  "send_test_chat_message mints the start's idempotency key and each turn's `turnId`/`attemptId` itself, and reads the session's current `executionGeneration` before sending. A caller's retry identity is the transport's operation id, not these owner fences.",
);
const testChatSkillEffectsAlwaysSuppressed = permanent(
  "send_test_chat_message always runs with skill effects suppressed: letting a skill act outward would make a probe an act. It also refuses to continue a session that was started with effects allowed, which continues only in the dashboard.",
);

const retrievalSettingsOnlyPatchesTheDefaultSkill = permanent(
  "prepare_retrieval_settings only ever patches the agent's one default retrieval skill through a typed retrieval-specific `patch`. The generic target/config/replaceConfig/invocationMode/enabled surface belongs to the general skill editor (propose_skill_config), not this narrower tool.",
);

/**
 * Recorded gaps between an OpenAPI request body and the operator-copilot tool that stands in for
 * it. Keyed by tool name, then by the body field name missing from the tool's own top-level input
 * keys. Every gap the field-parity gate finds must be listed here with a specific reason — see
 * copilot-field-parity.test.ts.
 */
export const fieldExclusions: Record<string, Record<string, FieldParityExclusion>> = {
  document_search: {
    ...fields(["metadataFilter"], documentSearchUnreviewedMetadataFilter),
    ...fields(["includeDebug"], internalDebugTraceNeverToModel),
  },
  propose_document: {
    // A create must never silently replace an existing document; copilot-document-proposals.test.ts
    // ("has no field for an external document id...") pins that propose_document carries no such field.
    externalDocumentId: permanent(
      "A create must never silently replace an existing document by external id — copilot-document-proposals.test.ts ('has no field for an external document id, so a create can never silently replace an existing document') pins that propose_document carries no such field.",
    ),
    source: permanent(
      "Ingestion source identity (upload/website/connector) is operator-owned; a copilot-authored document is always the plain inline body createDocument accepts without a source.",
    ),
    documentEnrichmentOverride: deferred(
      "Needs the same one-run extraction semantics on proposal apply before Ray can offer it.",
    ),
  },
  propose_agent: {
    ...fields(["chunkingStrategy"], agentWizardChunkingIsIngestionConfig),
  },
  propose_agent_setting: {
    ...fields([
      "name", "internalName", "customInstruction", "suggestedQuestionsEnabled", "assistantLinkUtmEnabled",
      "citationDisplayEnabled", "contactRequestsEnabled", "webhookExportsEnabled", "handoffOnRetrievalMiss",
      "contactRequestDelivery", "theme", "branding", "retrievalEnabled", "sourceScope", "greetingInstruction",
      "assistantDefaultLocale", "proactiveGreetingEnabled", "chatModelOverride", "skillSettings", "surfaceSettings",
      "publicDescription", "agentCardEnabled", "publicAgentAccessEnabled", "walkInConversationsPerHour",
    ], agentSettingGenericKeyValue),
  },
  propose_context_variable: {
    ...fields(["source", "resolverSkillId", "maxAgeSeconds", "resolverTimeoutMs", "surfacing", "enabled"], contextVariableEnablementNesting),
  },
  propose_directive: {
    ...fields([
      "name", "condition", "action", "priority", "requiredCapabilities", "dependsOn", "excludes", "surfaces",
      "tags", "description", "binding", "lifecycle", "coverageCriteria", "enabled", "metadata",
    ], directiveIntentDrafted),
  },
  propose_directive_enablement: {
    ...fields([
      "name", "condition", "action", "priority", "requiredCapabilities", "dependsOn", "excludes", "surfaces",
      "tags", "description", "binding", "lifecycle", "coverageCriteria", "metadata",
    ], directiveEnablementLeavesFieldsAlone),
  },
  propose_ingestion_settings: {
    ...fields(["embeddingModel"], ingestionEmbeddingModelNeverList),
  },
  propose_workspace_setting: {
    ...fields(["assistant", "channels"], workspaceSettingFlattensGroups),
  },
  propose_routine: {
    ...fields(["name", "enabled", "activation", "slots", "steps", "transitions", "terminals", "completionExport", "exposure"], routineIntentDrafted),
  },
  propose_routine_edit: {
    ...fields(["name", "enabled", "activation", "slots", "steps", "terminals", "exposure"], routineEditFieldPatchNesting),
    ...fields(["transitions"], routineCannotReworkBranching),
    ...fields(["completionExport"], routineEditCompletionExportUnreachable),
  },
  propose_routine_exposure: {
    ...fields(["exposure"], routineExposureCarriedFlat),
    ...fields(["name", "activation", "slots", "steps", "transitions", "terminals", "completionExport"], routineExposureLeavesFieldsAlone),
  },
  prepare_routine_structure: {
    ...fields(["name", "enabled", "activation", "slots", "steps", "terminals", "transitions"], routineStructuralPreparationNesting),
    ...fields(["exposure"], routineStructuralPreparationExposureViaOwnTool),
    ...fields(["completionExport"], routineStructuralPreparationCompletionExportUnreachable),
  },
  propose_skill_config: {
    ...fields(["replaceConfig"], skillConfigAlwaysMergesNeverReplaces),
  },
  replay_eval_case: {
    ...fields(["snapshotId", "mode"], evalReplaySnapshotScopeUncovered),
    ...fields(["agentConfigOverride"], evalReplayAgentConfigOverrideNarrowed),
  },
  retrieval_probe: {
    ...fields(["includeDebug"], internalDebugTraceNeverToModel),
  },
  run_eval_suite: {
    ...fields(["allowLiveEffects"], evalSuiteNeverLiveEffects),
  },
  set_triage_state: {
    ...fields(["reason"], triageReasonIsDeprecatedCompat),
  },
  test_agent_turn: {
    ...fields(["bootstrapGreetingId", "startConversation"], turnProbeAlwaysTestsAMessage),
    ...fields(["stream"], turnProbeNoTransportChoice),
    ...fields(["includeDebug"], internalDebugTraceNeverToModel),
    ...fields(["sourceContext"], turnProbeNoLiveChannel),
    ...fields(["metadataFilter"], turnProbeUnreviewedMetadataFilter),
  },
  prepare_agent_publication: {
    ...fields(["expectedDraftGeneration"], publicationFenceIsReadFresh),
  },
  prepare_retrieval_settings: {
    ...fields(["target", "config", "replaceConfig", "invocationMode", "enabled"], retrievalSettingsOnlyPatchesTheDefaultSkill),
  },
  send_test_chat_message: {
    ...fields(["expectedDraftGeneration"], testChatDraftFenceIsReadFresh),
    ...fields(["revisionIds"], testChatRunsOneRevision),
    ...fields(["mode"], testChatComparisonUnreachable),
    ...fields(["testValues"], testChatSampleValuesUnreachable),
    ...fields(["seedConversationId"], testChatSeedUnreachable),
    ...fields(["idempotencyKey", "executionGeneration", "turnId", "attemptId"], testChatMintsItsOwnIdentities),
    ...fields(["skillEffects"], testChatSkillEffectsAlwaysSuppressed),
  },
};

// Ratchet: this may only ever decrease as tools land a real field or a nested one moves flat.
// Recorded at creation from the first full scan of every production descriptor's backing bodies:
//   document_search.metadataFilter, propose_document.documentEnrichmentOverride,
//   propose_routine_edit.transitions, propose_routine_edit.completionExport,
//   prepare_routine_structure.completionExport, replay_eval_case.snapshotId,
//   replay_eval_case.mode, test_agent_turn.metadataFilter
// The first scan also surfaced a tenth gap that was not a tool gap at all: the OpenAPI
// `getDocument` (GET) operation declared a `DocumentReprocessRequest` body it never read. The
// contract was corrected instead of the gap being recorded.
//   8 -> 11  send_test_chat_message moved startAgentTestExecution off the catalog-coverage deferred
//            list, where the whole operation had been uncovered. Its three unreached fields
//            (mode, testValues, seedConversationId) are the part of that deferral still open, now
//            recorded field by field rather than retired with the operation.
export const maxDeferredFieldParityExclusions = 11;
