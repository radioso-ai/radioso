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
