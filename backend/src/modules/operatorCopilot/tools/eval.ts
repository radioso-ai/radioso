import { z } from "zod";

import type { CopilotToolDescriptor } from "../contracts.js";
import {
  MAX_COPILOT_EVAL_SUITE_CASES,
  type CopilotEvalCaseCapturePort,
  type CopilotEvalSuiteAssertionVerdict,
  type CopilotEvalSuiteCaseResult,
  type CopilotEvalSuiteProbePort,
} from "../contracts/evalCases.js";
import { boundPayload } from "../payloadCompaction.js";
import { asRecord, describeNamedAgent, entity, requiredPageAgent, type CopilotAgentLookupPort } from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);
const unknownRecord = z.record(z.unknown());
const MAX_FAILED_ASSERTIONS_PER_CASE = 5;
const MAX_SUITE_CASE_ID_ARGUMENTS = MAX_COPILOT_EVAL_SUITE_CASES * 4;

export interface CopilotEvalResultsPort {
  listWithLatestRun(workspaceId: string): Promise<ReadonlyArray<object>>;
}

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
      const cases = (await deps.evalResultsService.listWithLatestRun(context.workspaceId)).map(asRecord)
        .filter((item) => agentIdForEvalCase(item) === resolvedAgentId)
        .sort((left, right) => newestEvalResultFirst(left, right))
        .slice(0, limit ?? 20);
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

type CaptureInput = z.infer<typeof captureInputSchema>;
type CaptureOutput = z.infer<typeof captureOutputSchema>;
type SuiteRunInput = z.infer<typeof suiteRunInputSchema>;
type SuiteRunOutput = z.infer<typeof suiteRunOutputSchema>;

export interface EvalVerificationCopilotToolDependencies {
  readonly evalCaseCapture: CopilotEvalCaseCapturePort;
  readonly evalSuiteProbe: CopilotEvalSuiteProbePort;
}

const CAPTURE_DESCRIPTION = "Capture a bad assistant turn as a permanent eval case. Idempotent: a turn that is already captured returns its existing case unchanged.";
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
];

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

const agentIdForEvalCase = (item: Record<string, unknown>): string | null => {
  const agent = item.agent;
  return agent && typeof agent === "object" && "agentId" in agent && typeof agent.agentId === "string" ? agent.agentId : null;
};
const newestEvalResultFirst = (left: Record<string, unknown>, right: Record<string, unknown>): number => latestEvalTime(right) - latestEvalTime(left);
const latestEvalTime = (item: Record<string, unknown>): number => {
  const latestRun = item.latestRun;
  if (!latestRun || typeof latestRun !== "object") return 0;
  const completedAt = "completedAt" in latestRun ? latestRun.completedAt : undefined;
  const startedAt = "startedAt" in latestRun ? latestRun.startedAt : undefined;
  const timestamp = typeof completedAt === "string" ? completedAt : typeof startedAt === "string" ? startedAt : undefined;
  const value = timestamp ? Date.parse(timestamp) : 0;
  return Number.isFinite(value) ? value : 0;
};
