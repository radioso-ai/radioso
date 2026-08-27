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
     * Directive ids to drop from the replayed configuration. The replay service resolves and
     * applies these itself against the case's source agent's real directives — never against a
     * model-supplied `authoredDirectives` array, which carries no id a caller can trust — so this
     * is the only seam that can honestly back `propose_directive_removal` evidence. Mutually
     * exclusive with `authoredDirectives` in the same call.
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
   * `propose_directive_removal` evidence citation checks — never `overrides` itself, which is
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
 * Reads the real identity behind an agent's authored directives — id paired with canonical
 * content — so a replay's `excludedDirectiveIds` can be validated and applied against something
 * the model cannot author. No replay override carries a directive's real id, so this is the only
 * source of truth for "does this id exist, and what does it serialize to."
 */
export interface CopilotAgentDirectivesPort {
  listDirectives(
    workspaceId: string,
    agentId: string,
  ): Promise<ReadonlyArray<{ id: string; config: Record<string, unknown> }>>;
}
