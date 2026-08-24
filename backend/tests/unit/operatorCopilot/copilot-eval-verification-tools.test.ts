import { describe, expect, it, vi } from "vitest";

import { createEvalVerificationCopilotTools } from "../../../src/modules/operatorCopilot/tools/eval.js";
import {
  MAX_COPILOT_EVAL_SUITE_CASES,
  type CopilotEvalCaseCapturePort,
  type CopilotEvalSuiteProbePort,
} from "../../../src/modules/operatorCopilot/contracts/evalCases.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  pageContext: { view: "evals" as const, agentId: "agent-1", conversationId: null, selection: null, entities: [] },
};

const caseId = "11111111-1111-4111-8111-111111111111";
const otherCaseId = "22222222-2222-4222-8222-222222222222";
const assistantMessageId = "33333333-3333-4333-8333-333333333333";
const snapshotId = "44444444-4444-4444-8444-444444444444";
const thirdCaseId = "66666666-6666-4666-8666-666666666666";
const fourthCaseId = "77777777-7777-4777-8777-777777777777";

const ports = (overrides: {
  capture?: CopilotEvalCaseCapturePort["captureFromTurn"];
  runCases?: CopilotEvalSuiteProbePort["runCases"];
} = {}) => {
  const captureFromTurn = overrides.capture ?? vi.fn(async () => ({
    caseId,
    name: "2026-08-24 · \"Where is my order?\"",
    snapshotId,
    status: "pending" as const,
    assertionCount: 0,
    created: true,
  }));
  const runCases = overrides.runCases ?? vi.fn(async () => ({
    results: [],
    summary: { total: 0, scored: 0, passing: 0, failing: 0, error: 0, pending: 0, unscored: 0 },
  }));
  return {
    captureFromTurn,
    runCases,
    descriptors: createEvalVerificationCopilotTools({
      evalCaseCapture: { captureFromTurn },
      evalSuiteProbe: { runCases },
    }),
  };
};

const descriptorNamed = (descriptors: ReturnType<typeof ports>["descriptors"], name: string) => {
  const descriptor = descriptors.find((candidate) => candidate.name === name);
  if (!descriptor) throw new Error(`Missing descriptor ${name}`);
  return descriptor;
};

describe("copilot eval verification tools", () => {
  it("declares capture as an act and the suite run as a probe, matching the eval route permission", () => {
    const { descriptors } = ports();

    expect(descriptors.map(({ name, shape, requiredPermissions, contributingModule, uiLabel }) => ({
      name, shape, requiredPermissions, contributingModule, uiLabel,
    }))).toEqual([
      {
        name: "create_eval_case_from_turn",
        shape: "act",
        requiredPermissions: ["workspace.retrieval.query"],
        contributingModule: "eval",
        uiLabel: "Capturing an eval case",
      },
      {
        name: "run_eval_suite",
        shape: "probe",
        requiredPermissions: ["workspace.retrieval.query"],
        contributingModule: "eval",
        uiLabel: "Running eval cases",
      },
    ]);
  });

  it("captures a turn as a case and hands the operator the case it created", async () => {
    const { captureFromTurn, descriptors } = ports();
    const descriptor = descriptorNamed(descriptors, "create_eval_case_from_turn");

    const result = await descriptor.createTool(context).invoke({ assistantMessageId }, {} as never);

    expect(captureFromTurn).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      assistantMessageId,
    });
    expect(result).toEqual({
      evalCase: {
        id: caseId,
        name: "2026-08-24 · \"Where is my order?\"",
        snapshotId,
        status: "pending",
        assertionCount: 0,
      },
      created: true,
    });
    // The handoff must point at the captured case, not at the eval collection.
    expect(descriptor.describeOutputEntity?.(result)).toEqual({ type: "eval", id: caseId });
  });

  it("reports an already-captured turn as unchanged rather than as a new case", async () => {
    const capture = vi.fn(async () => ({
      caseId,
      name: "Existing case",
      snapshotId,
      status: "failing" as const,
      assertionCount: 2,
      created: false,
    }));
    const { descriptors } = ports({ capture });

    const result = await descriptorNamed(descriptors, "create_eval_case_from_turn")
      .createTool(context).invoke({ assistantMessageId }, {} as never);

    expect(result).toMatchObject({ created: false, evalCase: { status: "failing", assertionCount: 2 } });
  });

  it("runs only the selected cases and reports the whole suite's standing", async () => {
    const runCases = vi.fn(async () => ({
      results: [
        {
          caseId,
          name: "Refund window",
          status: "fail" as const,
          error: null,
          run: {
            status: "fail" as const,
            assertionVerdicts: [
              { assertion: { type: "answer_contains" }, status: "fail" as const, reason: "Answer did not contain \"30 days\"" },
              { assertion: { type: "answer_cites_document" }, status: "pass" as const, reason: null },
            ],
          },
        },
        { caseId: otherCaseId, name: "No expectations", status: "skipped" as const, error: null, run: null },
      ],
      summary: { total: 7, scored: 5, passing: 3, failing: 1, error: 0, pending: 1, unscored: 2 },
    }));
    const { descriptors } = ports({ runCases });

    const result = await descriptorNamed(descriptors, "run_eval_suite")
      .createTool(context).invoke({ caseIds: [caseId, otherCaseId], mode: "full_assistant" }, {} as never);

    expect(runCases).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      caseIds: [caseId, otherCaseId],
      mode: "full_assistant",
    });
    expect(result).toEqual({
      mode: "full_assistant",
      results: [
        {
          caseId,
          name: "Refund window",
          status: "fail",
          error: null,
          failedAssertions: [{ type: "answer_contains", reason: "Answer did not contain \"30 days\"" }],
        },
        { caseId: otherCaseId, name: "No expectations", status: "skipped", error: null, failedAssertions: [] },
      ],
      unknownCaseIds: [],
      summary: { total: 7, scored: 5, passing: 3, failing: 1, error: 0, pending: 1, unscored: 2 },
    });
  });

  it("names the selected cases that never ran instead of reporting them as passing", async () => {
    // The suite runner ignores ids it cannot resolve in the workspace. Swallowing that would let
    // Ray report a green suite for cases it never touched.
    const runCases = vi.fn(async () => ({
      results: [{ caseId, name: "Refund window", status: "pass" as const, error: null, run: null }],
      summary: { total: 1, scored: 1, passing: 1, failing: 0, error: 0, pending: 0, unscored: 0 },
    }));
    const { descriptors } = ports({ runCases });

    const result = await descriptorNamed(descriptors, "run_eval_suite")
      .createTool(context).invoke({ caseIds: [caseId, otherCaseId] }, {} as never) as { unknownCaseIds: string[] };

    expect(result.unknownCaseIds).toEqual([otherCaseId]);
  });

  it("counts distinct cases against the cap, so a repeated id is not extra work", async () => {
    // The cap exists because each case costs a replay. Rejecting a selection whose repeats push the
    // raw array over the cap refuses work that is within budget, and the service behind the tool
    // already dedupes — the two bounds have to measure the same thing.
    const { descriptors, runCases } = ports();
    const descriptor = descriptorNamed(descriptors, "run_eval_suite");
    const repeated = [caseId, caseId, caseId, otherCaseId, thirdCaseId, fourthCaseId];

    expect(() => descriptor.inputSchema.parse({ caseIds: repeated })).not.toThrow();

    await descriptor.createTool(context).invoke({ caseIds: repeated }, {} as never);

    expect(runCases).toHaveBeenCalledWith(expect.objectContaining({
      caseIds: [caseId, otherCaseId, thirdCaseId, fourthCaseId],
    }));
  });

  it("names an unresolvable id once however many times it was asked for", async () => {
    const runCases = vi.fn(async () => ({
      results: [],
      summary: { total: 0, scored: 0, passing: 0, failing: 0, error: 0, pending: 0, unscored: 0 },
    }));
    const { descriptors } = ports({ runCases });

    const result = await descriptorNamed(descriptors, "run_eval_suite")
      .createTool(context).invoke({ caseIds: [caseId, caseId, otherCaseId] }, {} as never) as { unknownCaseIds: string[] };

    expect(result.unknownCaseIds).toEqual([caseId, otherCaseId]);
  });

  it("defaults to a full assistant run and refuses more cases than one call may hold", async () => {
    const { descriptors, runCases } = ports();
    const descriptor = descriptorNamed(descriptors, "run_eval_suite");

    await descriptor.createTool(context).invoke({ caseIds: [caseId] }, {} as never);
    expect(runCases).toHaveBeenCalledWith(expect.objectContaining({ mode: "full_assistant" }));

    // Sequential server-side runs mean an unbounded selection is a tool call that hangs for
    // minutes. Ray batches instead.
    expect(() => descriptor.inputSchema.parse({
      caseIds: Array.from({ length: MAX_COPILOT_EVAL_SUITE_CASES + 1 }, (_, index) =>
        `5555555${index}-5555-4555-8555-555555555555`),
    })).toThrow();
  });

  it("keeps run payloads out of the result", async () => {
    const runCases = vi.fn(async () => ({
      results: [{
        caseId,
        name: "Refund window",
        status: "pass" as const,
        error: null,
        run: { status: "pass" as const, assertionVerdicts: [], observedOutput: { answer: "x".repeat(5_000) } },
      }],
      summary: { total: 1, scored: 1, passing: 1, failing: 0, error: 0, pending: 0, unscored: 0 },
    }));
    const { descriptors } = ports({ runCases });

    const result = await descriptorNamed(descriptors, "run_eval_suite")
      .createTool(context).invoke({ caseIds: [caseId] }, {} as never);

    expect(JSON.stringify(result)).not.toContain("x".repeat(1_000));
  });
});
