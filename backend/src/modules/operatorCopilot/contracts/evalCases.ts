/**
 * Ray's verification surface over the eval module: capture a bad turn as a case, then re-run
 * cases to see whether a change moved them. Both ports are owned by the copilot consumer and
 * carry only the fields its tools present, so an eval-side result shape can grow without
 * widening what Ray reads.
 */

/**
 * One call's ceiling on a suite run. The eval suite runs its cases sequentially server-side and
 * each full-assistant case costs an answer call plus a judge call, so an unbounded selection is a
 * tool call that hangs for minutes. Ray batches instead, and the summary still reports the whole
 * suite's standing because unrun cases keep their persisted verdict.
 */
export const MAX_COPILOT_EVAL_SUITE_CASES = 5;

export type CopilotEvalCaseStatus = "pending" | "passing" | "failing" | "error";
export type CopilotEvalRunMode = "retrieval_only" | "full_assistant";
export type CopilotEvalSuiteCaseStatus = "pass" | "fail" | "error" | "recorded" | "skipped";

/**
 * One eval case as Ray's readers see it. Typed here rather than passed through as an opaque
 * record, because the digest ranks cases by verdict and recency: a reader that re-derives those
 * fields from `unknown` re-implements the eval row shape at every call site that needs them.
 */
export interface CopilotEvalCaseSummary {
  readonly id: string;
  readonly name: string;
  readonly status: CopilotEvalCaseStatus;
  readonly updatedAt: string;
  /** The agent the case replays against. `agentId` is null for legacy thin snapshots. */
  readonly agent: { readonly agentId: string | null; readonly name: string | null };
  readonly latestRun: { readonly startedAt: string; readonly completedAt: string | null } | null;
}

export interface CopilotEvalResultsPort {
  listWithLatestRun(workspaceId: string): Promise<ReadonlyArray<CopilotEvalCaseSummary>>;
}

export interface CopilotEvalOperatorSubject {
  workspaceId: string;
  accountId: string;
  operatorUserId: string;
}

export interface CopilotEvalCaseCaptureInput extends CopilotEvalOperatorSubject {
  assistantMessageId: string;
}

export interface CopilotEvalCaseCaptureResult {
  caseId: string;
  name: string;
  snapshotId: string;
  status: CopilotEvalCaseStatus;
  assertionCount: number;
  /** False when the turn was already linked to a case, so the call changed nothing. */
  created: boolean;
}

export interface CopilotEvalCaseCapturePort {
  captureFromTurn(input: CopilotEvalCaseCaptureInput): Promise<CopilotEvalCaseCaptureResult>;
}

/** Narrow port over the eval module's get-or-create-by-source-message path. */
export interface CopilotEvalMessageCasePort {
  findOrCreate(input: {
    workspaceId: string;
    assistantMessageId: string;
    createdBy?: string | null;
  }): Promise<{
    case: {
      id: string;
      name: string;
      snapshotId: string;
      status: CopilotEvalCaseStatus;
      assertions: ReadonlyArray<unknown>;
    };
    created: boolean;
  }>;
}

export interface CopilotEvalSuiteAssertionVerdict {
  assertion: { type: string };
  status: "pass" | "fail" | "error";
  reason: string | null;
}

export interface CopilotEvalSuiteCaseResult {
  caseId: string;
  name: string;
  status: CopilotEvalSuiteCaseStatus;
  /** Set only when the case could not be run at all, e.g. its snapshot is gone. */
  error: string | null;
  run: {
    status: string;
    assertionVerdicts: ReadonlyArray<CopilotEvalSuiteAssertionVerdict>;
  } | null;
}

export interface CopilotEvalSuiteSummary {
  total: number;
  scored: number;
  passing: number;
  failing: number;
  error: number;
  pending: number;
  unscored: number;
}

export interface CopilotEvalSuiteProbeResult {
  results: ReadonlyArray<CopilotEvalSuiteCaseResult>;
  /** Covers the whole workspace suite, not only the cases this call ran. */
  summary: CopilotEvalSuiteSummary;
}

export interface CopilotEvalSuiteProbeInput extends CopilotEvalOperatorSubject {
  caseIds: ReadonlyArray<string>;
  mode?: CopilotEvalRunMode;
}

export interface CopilotEvalSuiteProbePort {
  runCases(input: CopilotEvalSuiteProbeInput): Promise<CopilotEvalSuiteProbeResult>;
}

/** Narrow port over the eval module's batch run path. */
export interface CopilotEvalSuiteRunnerPort {
  run(input: {
    workspaceId: string;
    accountId?: string | null;
    mode?: CopilotEvalRunMode;
    caseIds?: string[];
  }): Promise<CopilotEvalSuiteProbeResult>;
}

export type CopilotEvalRunStatus = "pass" | "fail" | "error" | "recorded";

/**
 * The behavior-bearing subset of the eval module's override set. A replay measures configuration
 * Ray is about to propose, so the cosmetic agent fields the eval route also accepts — logo, theme,
 * branding — are deliberately absent: they cannot change a verdict and would only invite the model
 * to send them. Everything `propose_agent_setting` can propose that *does* change behavior belongs
 * here, or Ray can draft a proposal it has no way to measure.
 */
export interface CopilotEvalCaseReplayOverrides {
  /** Answers "would another model get this right"; the grader keeps the workspace default. */
  modelOverride?: { provider: "openai" | "openai-compatible" | "gemini" | "claude"; model: string };
  assistantInstructionsOverride?: { customInstruction?: string };
  retrievalSettingsOverride?: {
    queryRewriteEnabled?: boolean;
    rerankEnabled?: boolean;
    vectorTopK?: number;
    similarityThreshold?: number;
    rerankTopK?: number;
    customInstruction?: string;
  };
  agentConfigOverride?: {
    customInstruction?: string;
    greetingInstruction?: string;
    /** Merged key by key onto the captured settings, so a single skill's entry stands alone. */
    skillSettings?: Record<string, unknown>;
    authoredDirectives?: ReadonlyArray<Record<string, unknown>>;
    /**
     * Directive ids to drop from the replayed configuration. The replay service resolves each id
     * against the case's source agent's *live* directives only to learn which directive is meant
     * (a model-supplied `authoredDirectives` array carries no id a caller can trust), then removes
     * the matching entry from the case's *captured snapshot* directive set — never from the live
     * set — so a directive added or edited elsewhere on the agent since the snapshot was taken
     * cannot leak into the replay and get credited to this removal. A live directive that no
     * longer matches its snapshot counterpart (renamed, edited, or absent from the snapshot)
     * refuses the replay rather than guess. Mutually exclusive with `authoredDirectives` in the
     * same call.
     */
    excludedDirectiveIds?: ReadonlyArray<string>;
  };
  /** Seeds a mid-routine starting position, which is where routine defects concentrate. */
  routineStartState?: {
    routineId: string;
    path: ReadonlyArray<string>;
    variables: Record<string, unknown>;
    attempts?: Record<string, number>;
    status: "active" | "suspended" | "completed" | "expired";
    metadata?: Record<string, unknown>;
  };
}

export interface CopilotEvalCaseReplayInput extends CopilotEvalOperatorSubject {
  caseId: string;
  /** The thread the measurement belongs to, recorded so evidence stays attributable. */
  copilotConversationId: string;
  overrides?: CopilotEvalCaseReplayOverrides;
}

export interface CopilotEvalCaseReplayResult {
  caseId: string;
  name: string;
  /** What this replay's configuration produced. */
  verdict: CopilotEvalRunStatus;
  /** The case's stored verdict, which a replay leaves untouched. */
  recordedStatus: CopilotEvalCaseStatus;
  assertionCount: number;
  answer: string | null;
  groundingVerdict: string | null;
  groundingDiagnostics: unknown;
  assertionVerdicts: ReadonlyArray<CopilotEvalSuiteAssertionVerdict>;
  model: { provider: string | null; id: string | null };
  /** Set when the replayed turn itself failed, so no verdict reflects the configuration. */
  error: string | null;
  /**
   * Handle a later proposal cites to carry this measurement. Null when the case's snapshot
   * captured no agent, so there is no configuration version to date the measurement against.
   */
  evidenceId: string | null;
}

export interface CopilotEvalCaseReplayPort {
  replayCase(input: CopilotEvalCaseReplayInput): Promise<CopilotEvalCaseReplayResult>;
}

/** Narrow port over the eval module's case reader. */
export interface CopilotEvalCaseReaderPort {
  findCase(workspaceId: string, caseId: string): Promise<{
    id: string;
    name: string;
    snapshotId: string;
    status: CopilotEvalCaseStatus;
    assertions: ReadonlyArray<unknown>;
    /** The agent whose captured configuration a replay of this case runs against. */
    sourceAgentId: string | null;
    /** When that configuration was captured. */
    snapshotCapturedAt: Date | null;
    /**
     * The source agent's authored directives exactly as this case's snapshot captured them
     * (serialized, no ids — same shape a directive's live config serializes to). This is the set
     * `excludedDirectiveIds` actually varies: the case's recorded verdict describes this snapshot,
     * never the agent's directives as they stand today, so a replay that wants to measure "this
     * case without directive X" must start here rather than from the live agent. Empty when the
     * case captured no agent.
     */
    snapshotAuthoredDirectives: ReadonlyArray<Record<string, unknown>>;
    /**
     * The retrieve default-answer skill's config exactly as this case's snapshot captured it, or
     * `null` when the snapshot captured no agent or that agent had no default-answer skill at
     * capture time. What an `agent_skill` proposal's evidence compares the *live* skill against
     * (see {@link CopilotAgentSkillConfigPort}) to decide whether the measurement is stale.
     */
    snapshotDefaultAnswerSkill: CopilotSkillConfigEnvelope | null;
  } | null>;
}

/** Narrow port over the eval module's run path, in its detached form. */
export interface CopilotEvalCaseReplayRunnerPort {
  execute(input: {
    workspaceId: string;
    accountId?: string | null;
    snapshotId: string;
    caseId: string;
    mode: CopilotEvalRunMode;
    overrides?: CopilotEvalCaseReplayOverrides;
    attachToCase: boolean;
  }): Promise<{
    run: {
      id: string;
      status: CopilotEvalRunStatus;
      assertionVerdicts: ReadonlyArray<CopilotEvalSuiteAssertionVerdict>;
      observedOutput: {
        answer?: string;
        groundingVerdict?: string;
        groundingDiagnostics?: unknown;
        error?: { message: string };
      };
      resolvedConfig: { modelProvider?: string; modelId?: string };
    };
  }>;
}

/**
 * One replay an operator ran before drafting a proposal. Recorded server-side rather than
 * reported by the model: evidence the assistant could author is not evidence.
 */
export interface CopilotReplayEvidenceRecord {
  id: string;
  workspaceId: string;
  operatorUserId: string;
  conversationId: string;
  agentId: string;
  caseId: string;
  caseName: string;
  runId: string;
  /**
   * When the eval case froze the agent configuration the replay ran against. The replay never
   * reads the live agent config, so an edit any time after this point dates the measurement.
   */
  baselineCapturedAt: Date;
  /** The case's recorded verdict before the replay. */
  recordedStatus: CopilotEvalCaseStatus;
  /** What the replayed configuration produced. */
  verdict: CopilotEvalRunStatus;
  overrides: CopilotEvalCaseReplayOverrides;
  /**
   * Real directive ids the replay service validated and excluded from this replay's
   * configuration, resolved against the source agent's actual directives rather than read from
   * `overrides`. Empty when the replay requested no exclusion. This is what a
   * `propose_directive_removal` or a disable `propose_directive_enablement` evidence citation
   * checks — never `overrides` itself, which is
   * whatever the model supplied and can omit a directive's id without proving its absence.
   */
  directivesExcluded: ReadonlyArray<string>;
  createdAt: Date;
}

export interface CopilotReplayEvidenceRepositoryPort {
  record(input: Omit<CopilotReplayEvidenceRecord, "id" | "createdAt">): Promise<CopilotReplayEvidenceRecord>;
  /** Scoped to the operator who measured it; evidence is never citable across operators. */
  findMany(input: {
    workspaceId: string;
    operatorUserId: string;
    ids: ReadonlyArray<string>;
  }): Promise<ReadonlyArray<CopilotReplayEvidenceRecord>>;
}

/** Reads the agent version that decides whether a measurement still describes today's agent. */
export interface CopilotAgentVersionPort {
  get(workspaceId: string, agentId: string): Promise<{ updatedAt: Date }>;
}

/**
 * The retrieve default-answer skill's `{ enabled, settings }` envelope — the shape both a case
 * snapshot's captured skill config ({@link CopilotEvalCaseReaderPort.findCase}'s
 * `snapshotDefaultAnswerSkill`) and a replay override's `skillSettings[key]` take. `settings` is
 * the raw tuning blob; run it through `effectiveRetrieveAnswerSkillSettings` (agentConfig.ts) to
 * canonicalize before comparing against anything.
 */
export interface CopilotSkillConfigEnvelope {
  enabled: unknown;
  settings: Record<string, unknown>;
}

/**
 * Reads the retrieve default-answer skill's *live* stored configuration. A skill edit persists
 * through `agent_skills`, a table {@link CopilotAgentVersionPort} never reads, so an `agent_skill`
 * proposal's evidence cannot lean on an agent-wide version signal — it instead compares this
 * directly against what the cited case's snapshot captured (see proposalEvidenceService's
 * `resolveAgentSkillDrift`). `null` when the agent has no default-answer skill right now (never
 * configured, or deleted since the case was captured) — with nothing left to compare a
 * measurement against, that always reads stale.
 */
export interface CopilotAgentSkillConfigPort {
  getDefaultAnswerSkill(
    workspaceId: string,
    agentId: string,
  ): Promise<{ enabled: boolean; config: Record<string, unknown> } | null>;
}

/**
 * Reads the real identity behind an agent's authored directives — id paired with canonical
 * content — so a replay's `excludedDirectiveIds` can be validated against something the model
 * cannot author. No replay override carries a directive's real id, so this is the only source of
 * truth for "does this id exist, and what does it serialize to" — the replay then matches that
 * identity into the case's captured snapshot by name rather than applying this live content.
 */
export interface CopilotAgentDirectivesPort {
  listDirectives(
    workspaceId: string,
    agentId: string,
  ): Promise<ReadonlyArray<{ id: string; config: Record<string, unknown> }>>;
}
