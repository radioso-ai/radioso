import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import {
  MAX_COPILOT_EVAL_SUITE_CASES,
  type CopilotEvalCaseCapturePort,
  type CopilotEvalCaseReplayPort,
  type CopilotEvalCaseSummary,
  type CopilotEvalResultsPort,
  type CopilotEvalSuiteAssertionVerdict,
  type CopilotEvalSuiteCaseResult,
  type CopilotEvalSuiteProbePort,
} from "../contracts/evalCases.js";
import { boundPayload } from "../payloadCompaction.js";
import { asRecord, describeNamedAgent, entity, requiredCopilotConversation, requiredPageAgent, type CopilotAgentLookupPort } from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const unknownRecord = z.record(z.unknown());
const MAX_FAILED_ASSERTIONS_PER_CASE = 5;
const MAX_REPLAY_ANSWER_CHARS = 2_000;
const MAX_SUITE_CASE_ID_ARGUMENTS = MAX_COPILOT_EVAL_SUITE_CASES * 4;

export type { CopilotEvalResultsPort } from "../contracts/evalCases.js";

export interface EvalCopilotToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly evalResultsService: CopilotEvalResultsPort;
}

export const createEvalCopilotTools = (deps: EvalCopilotToolDependencies): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "eval_results", shape: "read", uiLabel: "Reading eval results", contributingModule: "eval", dashboardSubject: { type: "eval" }, requiredPermissions: ["workspace.retrieval.query"],
    description: "Read recent evaluation cases and their latest outcomes for an agent.",
    inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ cases: z.array(unknownRecord) }),
    createTool: (context) => ({ name: "eval_results", description: "Read recent evaluation cases and their latest outcomes for an agent.", inputSchema: z.object({ agentId: idSchema.optional(), agentName: entityNameSchema.optional(), limit: z.number().int().min(1).max(50).optional() }), outputSchema: z.object({ cases: z.array(unknownRecord) }), invoke: async ({ agentId, limit }) => {
      const resolvedAgentId = agentId ?? requiredPageAgent(context.pageContext.agentId);
      const cases = (await deps.evalResultsService.listWithLatestRun(context.workspaceId))
        .filter((evalCase) => evalCase.agent.agentId === resolvedAgentId)
        .sort(newestEvalResultFirst)
        .slice(0, limit ?? 20)
        .map(asRecord);
      return boundPayload({ cases }) as { cases: Record<string, unknown>[] };
    } }),
    describeEntity: (input, context) => {
      const parsed = input as { agentId?: string; agentName?: string };
      return parsed.agentName
        ? describeNamedAgent(parsed, context, deps.agentLookup)
        : entity("agent", parsed.agentId ?? context?.pageContext.agentId);
    },
  },
];

const evalRunModeSchema = z.enum(["retrieval_only", "full_assistant"]);

const captureInputSchema = z.object({ assistantMessageId: idSchema }).strict();
const captureOutputSchema = z.object({
  evalCase: z.object({
    id: idSchema,
    name: z.string().max(240),
    snapshotId: idSchema,
    status: z.enum(["pending", "passing", "failing", "error"]),
    assertionCount: z.number().int().nonnegative(),
  }).strict(),
  created: z.boolean(),
}).strict();

const suiteRunInputSchema = z.object({
  // The cap counts distinct cases, because the cost it bounds is one replay per case and a repeated
  // id is not a second replay. The raw ceiling above it only keeps a malformed argument list from
  // reaching the runner; it is not the rule the operator is subject to.
  caseIds: z.array(idSchema).min(1).max(MAX_SUITE_CASE_ID_ARGUMENTS).superRefine((caseIds, context) => {
    const distinct = new Set(caseIds).size;
    if (distinct > MAX_COPILOT_EVAL_SUITE_CASES) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: MAX_COPILOT_EVAL_SUITE_CASES,
        inclusive: true,
        message: `At most ${MAX_COPILOT_EVAL_SUITE_CASES} distinct eval cases may be run in one call`,
      });
    }
  }),
  mode: evalRunModeSchema.optional(),
}).strict();
const suiteRunOutputSchema = z.object({
  mode: evalRunModeSchema,
  results: z.array(z.object({
    caseId: idSchema,
    name: z.string().max(240),
    status: z.enum(["pass", "fail", "error", "recorded", "skipped"]),
    error: z.string().max(500).nullable(),
    failedAssertions: z.array(z.object({
      type: z.string().max(120),
      reason: z.string().max(400).nullable(),
    }).strict()).max(MAX_FAILED_ASSERTIONS_PER_CASE),
  }).strict()).max(MAX_COPILOT_EVAL_SUITE_CASES),
  /** Selected ids the suite could not resolve in this workspace, so nothing ran for them. */
  unknownCaseIds: z.array(idSchema).max(MAX_COPILOT_EVAL_SUITE_CASES),
  summary: z.object({
    total: z.number().int().nonnegative(),
    scored: z.number().int().nonnegative(),
    passing: z.number().int().nonnegative(),
    failing: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    unscored: z.number().int().nonnegative(),
  }).strict(),
}).strict();

/**
 * The behavior-bearing overrides only. The eval route also accepts logo, theme, and branding on
 * an agent config override; none of them can move a verdict, so offering them would only invite
 * the model to spend a replay on a cosmetic difference. Everything else it accepts stays, because
 * `propose_agent_setting` takes an arbitrary setting key: a behavior setting Ray can propose but
 * not replay is a proposal that cannot carry evidence. Partial values are safe — the replay merges
 * an override onto the captured config key by key rather than replacing whole records.
 */
const replayOverridesSchema = z.object({
  modelOverride: z.object({
    provider: z.enum(["openai", "openai-compatible", "gemini", "claude"]),
    model: z.string().min(1).max(200),
  }).strict().optional(),
  assistantInstructionsOverride: z.object({
    customInstruction: z.string().max(4000).optional(),
  }).strict().optional(),
  retrievalSettingsOverride: z.object({
    queryRewriteEnabled: z.boolean().optional(),
    rerankEnabled: z.boolean().optional(),
    vectorTopK: z.number().int().min(1).max(200).optional(),
    similarityThreshold: z.number().min(0).max(1).optional(),
    rerankTopK: z.number().int().min(1).max(50).optional(),
    customInstruction: z.string().max(4000).optional(),
  }).strict().optional(),
  agentConfigOverride: z.object({
    customInstruction: z.string().max(4000).optional(),
    greetingInstruction: z.string().max(4000).optional(),
    skillSettings: unknownRecord.optional(),
    authoredDirectives: z.array(unknownRecord).max(50).optional(),
    // Ids to drop from the replayed directive set. Resolved and applied server-side against the
    // case's source agent, never against authoredDirectives, so this is the only override that
    // can back propose_directive_removal or a disabling propose_directive_enablement evidence.
    // Cannot be combined with authoredDirectives.
    // Several ids at once is a fine way to explore "what if I dropped both of these", but the
    // resulting evidence only backs a removal or disable proposal for that exact combination: a
    // proposal affecting one of them alone needs its own replay excluding only that one id.
    excludedDirectiveIds: z.array(idSchema).max(50).optional(),
  }).strict().optional(),
  routineStartState: z.object({
    routineId: z.string().min(1).max(200),
    path: z.array(z.string().min(1).max(200)).min(1).max(200),
    variables: unknownRecord,
    attempts: z.record(z.number().int()).optional(),
    status: z.enum(["active", "suspended", "completed", "expired"]),
    metadata: unknownRecord.optional(),
  }).strict().optional(),
}).strict();

const replayInputSchema = z.object({
  caseId: idSchema,
  overrides: replayOverridesSchema.optional(),
}).strict();
const replayOutputSchema = z.object({
  caseId: idSchema,
  name: z.string().max(240),
  /** What the replayed configuration produced. */
  verdict: z.enum(["pass", "fail", "error", "recorded"]),
  /** What the library still records, because a replay does not move it. */
  recordedStatus: z.enum(["pending", "passing", "failing", "error"]),
  assertionCount: z.number().int().nonnegative(),
  answer: z.string().max(MAX_REPLAY_ANSWER_CHARS).nullable(),
  grounding: z.object({
    verdict: z.string().max(120).nullable(),
    diagnostics: unknownRecord.nullable(),
  }).strict(),
  failedAssertions: z.array(z.object({
    type: z.string().max(120),
    reason: z.string().max(400).nullable(),
  }).strict()).max(MAX_FAILED_ASSERTIONS_PER_CASE),
  model: z.object({
    provider: z.string().max(60).nullable(),
    id: z.string().max(200).nullable(),
  }).strict(),
  error: z.string().max(500).nullable(),
  /** Cite this on a propose_* call to carry the measurement onto the proposal. */
  evidenceId: idSchema.nullable(),
}).strict();

type CaptureInput = z.infer<typeof captureInputSchema>;
type CaptureOutput = z.infer<typeof captureOutputSchema>;
type SuiteRunInput = z.infer<typeof suiteRunInputSchema>;
type SuiteRunOutput = z.infer<typeof suiteRunOutputSchema>;
type ReplayInput = z.infer<typeof replayInputSchema>;
type ReplayOutput = z.infer<typeof replayOutputSchema>;

export interface EvalVerificationCopilotToolDependencies {
  readonly evalCaseCapture: CopilotEvalCaseCapturePort;
  readonly evalSuiteProbe: CopilotEvalSuiteProbePort;
  readonly evalCaseReplay: CopilotEvalCaseReplayPort;
}

const CAPTURE_DESCRIPTION = "Capture a bad assistant turn as a permanent eval case. Idempotent: a turn that is already captured returns its existing case unchanged.";
const REPLAY_DESCRIPTION = "Replay one captured eval case against a configuration that is not live yet, and report the verdict it produces, plus an evidenceId a later propose_* call can cite so the proposal carries the measurement. Use this to check a change before proposing it: the case keeps its recorded verdict either way, so a replay never moves the suite's pass rate. Always runs a full assistant turn and costs one, so replay the cases a change should affect rather than the library. To gather evidence for propose_directive_removal or disabling propose_directive_enablement, set agentConfigOverride.excludedDirectiveIds to the directive's id rather than hand-editing agentConfigOverride.authoredDirectives: the server resolves the id against the agent's real directives and removes it itself, so only that field can prove the directive was absent from the run. A proposal to remove or disable one directive can only cite a replay whose excludedDirectiveIds was that directive's id alone — replaying with other directives excluded too measures a different configuration and is refused, so exclude exactly the one directive you are proposing to affect. Exclusion evidence cannot support re-enabling, because it measures the directive absent from the run.";

const SUITE_RUN_DESCRIPTION = `Re-run up to ${MAX_COPILOT_EVAL_SUITE_CASES} named eval cases and report their outcomes plus the whole suite's standing. Each case replays for real: the run is recorded and the case's stored status moves to the new verdict. Cases run sequentially, so select the cases a change should affect rather than the whole library; list case ids with eval_results first.`;

/**
 * Ray's verification loop over the eval library: capture the turn that went wrong, then re-run
 * the cases a change should have moved. Kept apart from the eval reader so a session that only
 * reads results never carries the write and probe ports.
 *
 * Each descriptor is checked against its own input and output types and then widened to the
 * catalog's descriptor type, which is invariant in them; without the widening the two tools could
 * not share one array and their invoke arguments would fall back to `any`.
 */
export const createEvalVerificationCopilotTools = (
  deps: EvalVerificationCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => [
  {
    name: "create_eval_case_from_turn",
    shape: "act",
    uiLabel: "Capturing an eval case",
    contributingModule: "eval",
    dashboardSubject: { type: "eval" },
    requiredPermissions: ["workspace.retrieval.query"],
    description: CAPTURE_DESCRIPTION,
    inputSchema: captureInputSchema,
    outputSchema: captureOutputSchema,
    createTool: (context) => ({
      name: "create_eval_case_from_turn",
      description: CAPTURE_DESCRIPTION,
      inputSchema: captureInputSchema,
      outputSchema: captureOutputSchema,
      invoke: async ({ assistantMessageId }) => {
        const captured = await deps.evalCaseCapture.captureFromTurn({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
          operatorUserId: context.operatorUserId,
          assistantMessageId,
        });
        return captureOutputSchema.parse({
          evalCase: {
            id: captured.caseId,
            name: captured.name,
            snapshotId: captured.snapshotId,
            status: captured.status,
            assertionCount: captured.assertionCount,
          },
          created: captured.created,
        });
      },
    }),
    describeOutputEntity: (output) => entity("eval", output.evalCase.id),
  } satisfies CopilotToolDescriptor<CaptureInput, CaptureOutput> as CopilotToolDescriptor,
  {
    name: "run_eval_suite",
    // An act, not a probe: a run persists a row per case and moves each case's status, which is the
    // pass rate the Eval list reports. The compute cost alone would make it a probe; the persisted
    // verdict is what takes it out of work a transport may run unattended.
    shape: "act",
    uiLabel: "Running eval cases",
    contributingModule: "eval",
    dashboardSubject: { type: "eval" },
    requiredPermissions: ["workspace.retrieval.query"],
    description: SUITE_RUN_DESCRIPTION,
    inputSchema: suiteRunInputSchema,
    outputSchema: suiteRunOutputSchema,
    createTool: (context) => ({
      name: "run_eval_suite",
      description: SUITE_RUN_DESCRIPTION,
      inputSchema: suiteRunInputSchema,
      outputSchema: suiteRunOutputSchema,
      invoke: async ({ caseIds, mode }) => {
        const runMode = mode ?? "full_assistant";
        const requestedCaseIds = [...new Set(caseIds)];
        const outcome = await deps.evalSuiteProbe.runCases({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
          operatorUserId: context.operatorUserId,
          caseIds: requestedCaseIds,
          mode: runMode,
        });
        const ranCaseIds = new Set(outcome.results.map((result) => result.caseId));
        return suiteRunOutputSchema.parse({
          mode: runMode,
          results: outcome.results.map(projectSuiteCase),
          // The batch path silently drops ids it cannot resolve. Reporting a selected case as
          // simply absent from the results would read as "nothing wrong with it".
          unknownCaseIds: requestedCaseIds.filter((caseId) => !ranCaseIds.has(caseId)),
          summary: outcome.summary,
        });
      },
    }),
  } satisfies CopilotToolDescriptor<SuiteRunInput, SuiteRunOutput> as CopilotToolDescriptor,
  {
    name: "replay_eval_case",
    // A probe, not an act: the run is stored detached, so the case's verdict, its last-run
    // pointer, and the suite pass rate are all left where the library had them.
    shape: "probe",
    uiLabel: "Replaying an eval case",
    contributingModule: "eval",
    dashboardSubject: { type: "eval" },
    requiredPermissions: ["workspace.retrieval.query"],
    description: REPLAY_DESCRIPTION,
    inputSchema: replayInputSchema,
    outputSchema: replayOutputSchema,
    createTool: (context) => ({
      name: "replay_eval_case",
      description: REPLAY_DESCRIPTION,
      inputSchema: replayInputSchema,
      outputSchema: replayOutputSchema,
      invoke: async ({ caseId, overrides }) => {
        const replay = await deps.evalCaseReplay.replayCase({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
          operatorUserId: context.operatorUserId,
          copilotConversationId: requiredCopilotConversation(context),
          caseId,
          overrides,
        });
        return replayOutputSchema.parse({
          caseId: replay.caseId,
          name: clip(replay.name, 240),
          verdict: replay.verdict,
          recordedStatus: replay.recordedStatus,
          assertionCount: replay.assertionCount,
          answer: replay.answer === null ? null : clip(replay.answer, MAX_REPLAY_ANSWER_CHARS),
          grounding: {
            verdict: replay.groundingVerdict === null ? null : clip(replay.groundingVerdict, 120),
            diagnostics: boundedDiagnostics(replay.groundingDiagnostics),
          },
          failedAssertions: replay.assertionVerdicts
            .filter((verdict) => verdict.status !== "pass")
            .slice(0, MAX_FAILED_ASSERTIONS_PER_CASE)
            .map(projectFailedAssertion),
          model: replay.model,
          error: replay.error === null ? null : clip(replay.error, 500),
          evidenceId: replay.evidenceId,
        });
      },
    }),
    describeOutputEntity: (output) => entity("eval", output.caseId),
  } satisfies CopilotToolDescriptor<ReplayInput, ReplayOutput> as CopilotToolDescriptor,
];

/** Grounding diagnostics are unbounded by contract; a replay carries them only as evidence. */
const boundedDiagnostics = (diagnostics: unknown): Record<string, unknown> | null => {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return null;
  return boundPayload(diagnostics as Record<string, unknown>) as Record<string, unknown>;
};

const projectSuiteCase = (result: CopilotEvalSuiteCaseResult): SuiteRunOutput["results"][number] => ({
  caseId: result.caseId,
  name: clip(result.name, 240),
  status: result.status,
  error: result.error === null ? null : clip(result.error, 500),
  failedAssertions: (result.run?.assertionVerdicts ?? [])
    .filter((verdict) => verdict.status !== "pass")
    .slice(0, MAX_FAILED_ASSERTIONS_PER_CASE)
    .map(projectFailedAssertion),
});

const projectFailedAssertion = (verdict: CopilotEvalSuiteAssertionVerdict): { type: string; reason: string | null } => ({
  type: clip(verdict.assertion.type, 120),
  reason: verdict.reason === null ? null : clip(verdict.reason, 400),
});

const clip = (value: string, max: number): string => value.length <= max ? value : value.slice(0, max);

const newestEvalResultFirst = (left: CopilotEvalCaseSummary, right: CopilotEvalCaseSummary): number =>
  latestEvalTime(right) - latestEvalTime(left);
/** A case that has never run sorts last rather than crowding out cases with real results. */
const latestEvalTime = (evalCase: CopilotEvalCaseSummary): number => {
  const timestamp = evalCase.latestRun?.completedAt ?? evalCase.latestRun?.startedAt;
  const value = timestamp ? Date.parse(timestamp) : 0;
  return Number.isFinite(value) ? value : 0;
};
