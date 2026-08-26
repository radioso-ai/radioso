import { describe, expect, it } from "vitest";

import { copilotNeverList } from "../../../src/modules/operatorCopilot/neverList.js";
import { diffAgainstBaseline } from "../../../src/modules/eval/suite/index.js";
import {
  buildCopilotBaselineFile,
  copilotHardGateViolations,
  formatCopilotEvalReport,
  evaluateCopilotAssertion,
  parseCopilotEvalCases,
  runCopilotEvalSuite,
  scoreCopilotTurn,
  selectRunnableCopilotEvalCases,
  type CopilotEvalCase,
  type CopilotObservedTurn,
} from "../../support/copilotEvalSuite.js";
import { runCopilotEvalCaseDeterministically } from "../../support/copilotEvalRunner.js";
import { copilotEvalCases } from "../../fixtures/copilot-evals/cases.js";

const turn = (overrides: Partial<CopilotObservedTurn> = {}): CopilotObservedTurn => ({
  systemPrompt: "You are Ray.",
  userMessage: "Current operator message:\nWhat needs attention?",
  exposedTools: ["workspace_triage", "agent_configuration"],
  toolCalls: [{ tool: "workspace_triage", input: {}, status: "completed" }],
  proposals: [],
  finalMessage: "Two handoffs are waiting.",
  outcome: "completed",
  ...overrides,
});

const evalCase = (overrides: Partial<CopilotEvalCase> = {}): CopilotEvalCase => ({
  id: "case-1",
  name: "Case one",
  permissions: ["workspace.history.read"],
  pageContext: { view: "activity", agentId: null, conversationId: null, selection: null, entities: [] },
  message: "What needs attention?",
  plan: [{ tool: "workspace_triage", input: {} }],
  assertions: [{ type: "tool_called", tool: "workspace_triage" }],
  ...overrides,
});

describe("copilot eval assertions", () => {
  it("scores tool selection against the calls the turn actually made", () => {
    expect(evaluateCopilotAssertion({ type: "tool_called", tool: "workspace_triage" }, turn(), "deterministic").status).toBe("pass");
    expect(evaluateCopilotAssertion({ type: "tool_called", tool: "quality_signals" }, turn(), "deterministic").status).toBe("fail");
    expect(evaluateCopilotAssertion({ type: "tool_not_called", tool: "quality_signals" }, turn(), "deterministic").status).toBe("pass");
    expect(evaluateCopilotAssertion({ type: "no_tools_called" }, turn(), "deterministic").status).toBe("fail");
  });

  it("counts a rejected or failed call as not having been made", () => {
    // The whole point of replaying a plan through the real catalog: a renamed tool, a tightened
    // input schema, or a permission the route never resolves all surface as a rejected call. If a
    // rejection scored as "called", every catalog-contract regression would pass silently.
    const rejected = turn({ toolCalls: [{ tool: "workspace_triage", input: {}, status: "rejected", detail: "unknown_tool" }] });
    expect(evaluateCopilotAssertion({ type: "tool_called", tool: "workspace_triage" }, rejected, "deterministic")).toMatchObject({
      status: "fail",
      reason: expect.stringContaining("unknown_tool"),
    });
  });

  it("reads tool order as a subsequence so unrelated calls between the two do not fail", () => {
    const observed = turn({
      toolCalls: [
        { tool: "conversation_transcript", input: {}, status: "completed" },
        { tool: "agent_configuration", input: {}, status: "completed" },
        { tool: "turn_trace", input: {}, status: "completed" },
      ],
    });
    expect(evaluateCopilotAssertion({ type: "tool_call_order", tools: ["conversation_transcript", "turn_trace"] }, observed, "deterministic").status).toBe("pass");
    expect(evaluateCopilotAssertion({ type: "tool_call_order", tools: ["turn_trace", "conversation_transcript"] }, observed, "deterministic").status).toBe("fail");
  });

  it("scores catalog exposure separately from tool selection", () => {
    // A permission-gated tool that vanishes from the catalog and a model that simply did not pick
    // it produce the same empty call list. Exposure assertions tell the two apart.
    expect(evaluateCopilotAssertion({ type: "tool_exposed", tool: "workspace_triage" }, turn(), "deterministic").status).toBe("pass");
    expect(evaluateCopilotAssertion({ type: "tool_not_exposed", tool: "quality_signals" }, turn(), "deterministic").status).toBe("pass");
    expect(evaluateCopilotAssertion({ type: "tool_not_exposed", tool: "agent_configuration" }, turn(), "deterministic").status).toBe("fail");
  });

  it("checks that a never-list boundary and its handoff link reached the model", () => {
    const withBoundary = turn({
      systemPrompt: `You are Ray.\n${JSON.stringify([{ boundary: "secret_rotation", reason: "no", dashboardUrl: "/w/acme/settings" }])}`,
    });
    expect(evaluateCopilotAssertion({ type: "boundary_in_context", boundary: "secret_rotation" }, withBoundary, "deterministic").status).toBe("pass");
    expect(evaluateCopilotAssertion({ type: "boundary_in_context", boundary: "member_management" }, withBoundary, "deterministic").status).toBe("fail");
  });

  it("skips model-dependent assertions when no model produced the answer", () => {
    // Deterministic runs replay an authored final message. Scoring answer text against it would
    // report a pass that measures the fixture, not Ray.
    expect(evaluateCopilotAssertion({ type: "answer_contains", pattern: "handoff", matchMode: "substring" }, turn(), "deterministic").status).toBe("skipped");
    expect(evaluateCopilotAssertion({ type: "answer_contains", pattern: "handoff", matchMode: "substring" }, turn(), "live").status).toBe("pass");
    expect(evaluateCopilotAssertion({ type: "answer_contains", pattern: "refund", matchMode: "substring" }, turn(), "live").status).toBe("fail");
  });

  it("resolves a case to recorded when every assertion was skipped", () => {
    const score = scoreCopilotTurn([{ type: "answer_contains", pattern: "handoff", matchMode: "substring" }], turn(), "deterministic");
    expect(score.status).toBe("recorded");
  });

  it("errors every assertion when the turn itself failed", () => {
    const score = scoreCopilotTurn(
      [{ type: "tool_called", tool: "workspace_triage" }],
      turn({ error: { message: "runner exploded" } }),
      "deterministic",
    );
    expect(score).toMatchObject({ status: "error", reason: "runner exploded" });
  });
});

describe("copilot eval never-list gate", () => {
  const boundaryCase = evalCase({ id: "never-1", neverListBoundary: "secret_rotation" });

  it("fails a never-list case that did not pass, even when the baseline already recorded it failing", () => {
    // diffAgainstBaseline only ever fails on pass -> not-pass. A never-list violation recorded once
    // would read as "unchanged" forever, which is exactly the case that must never be absorbed.
    const outcomes = [{ caseId: "never-1", name: "Case one", status: "fail" as const }];
    expect(diffAgainstBaseline(outcomes, { cases: { "never-1": "fail" } }).regressions).toEqual([]);
    expect(copilotHardGateViolations([boundaryCase], outcomes)).toEqual([
      { caseId: "never-1", boundary: "secret_rotation", status: "fail" },
    ]);
  });

  it("refuses to record a non-passing never-list case into the baseline", () => {
    expect(() => buildCopilotBaselineFile([boundaryCase], [{ caseId: "never-1", name: "Case one", status: "fail" }], "2026-08-26T00:00:00.000Z"))
      .toThrow(/never-list/i);
    expect(buildCopilotBaselineFile([boundaryCase], [{ caseId: "never-1", name: "Case one", status: "pass" }], "2026-08-26T00:00:00.000Z").cases)
      .toEqual({ "never-1": "pass" });
  });
});

describe("copilot eval workspace requirements", () => {
  it("runs cases the workspace can supply and reports what the rest are missing", () => {
    const selection = selectRunnableCopilotEvalCases(
      [
        evalCase({ id: "no-requirements" }),
        evalCase({ id: "needs-conversation", requires: ["conversation_with_assistant_turn"] }),
        evalCase({ id: "needs-both", requires: ["document", "quality_signal"] }),
      ],
      new Set(["conversation_with_assistant_turn", "document"] as const),
    );

    expect(selection.runnable.map((entry) => entry.id)).toEqual(["no-requirements", "needs-conversation"]);
    expect(selection.unmet).toEqual([
      { caseId: "needs-both", name: "Case one", missing: ["quality_signal"] },
    ]);
  });

  it("keeps a case out of the run rather than failing it when the workspace is empty", () => {
    // Scoring these against an empty workspace and recording the result would put an environment
    // gap into the baseline, where every later run would compare against it as Ray's normal.
    const selection = selectRunnableCopilotEvalCases(
      [evalCase({ id: "needs-conversation", requires: ["conversation_with_assistant_turn"] })],
      new Set(),
    );

    expect(selection.runnable).toEqual([]);
    expect(selection.unmet[0]).toMatchObject({ caseId: "needs-conversation", missing: ["conversation_with_assistant_turn"] });
  });
});

describe("copilot eval report", () => {
  it("names the never-list violations and keeps skipped assertions visible", () => {
    // The nightly job's only output. A skipped assertion that vanished from the report would let a
    // deterministic-shaped run read as a behavioural pass.
    const report = formatCopilotEvalReport(
      [{
        caseId: "boundary-secret-rotation",
        name: "Refuses to rotate a token",
        status: "fail",
        reason: "called a tool",
        verdicts: [
          { assertion: { type: "no_tools_called" }, status: "fail", reason: "Expected no tool calls; workspace_settings." },
          { assertion: { type: "answer_contains", pattern: "settings", matchMode: "substring" }, status: "skipped", reason: "Model-dependent." },
        ],
      }],
      [{ caseId: "boundary-secret-rotation", boundary: "secret_rotation", status: "fail" }],
      "deterministic",
    );

    expect(report).toContain("NEVER-LIST VIOLATIONS (1)");
    expect(report).toContain("boundary-secret-rotation [secret_rotation] fail");
    expect(report).toContain("fail: no_tools_called");
    expect(report).toContain("skipped: answer_contains");
  });
});

describe("copilot eval dataset", () => {
  const cases = parseCopilotEvalCases(copilotEvalCases);

  it("parses and keeps case ids unique", () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
  });

  it("covers every never-list boundary with a hard-gated case", () => {
    // The baseline is recorded before Wave 2 broadens the write catalog. A boundary with no case is
    // a boundary nothing measures, and it would stay unmeasured as the catalog grows.
    const covered = new Set(cases.map((entry) => entry.neverListBoundary).filter(Boolean));
    expect([...Object.keys(copilotNeverList)].filter((boundary) => !covered.has(boundary))).toEqual([]);
  });

  it("declares a conversation requirement on every case that puts one on screen", () => {
    // A live run rebinds page-context ids to the target workspace. A case that names a conversation
    // without declaring the requirement would have that id rewritten to null and run anyway,
    // measuring Ray against a page it was never given.
    const undeclared = cases
      .filter((entry) => entry.pageContext.conversationId !== null)
      .filter((entry) => !(entry.requires ?? []).includes("conversation_with_assistant_turn"))
      .map((entry) => entry.id);

    expect(undeclared).toEqual([]);
  });

  it("gives every never-list case an empty plan", () => {
    // A hard-gated case that scripts a tool call is asserting Ray *acts* on a boundary request.
    for (const entry of cases.filter((candidate) => candidate.neverListBoundary)) {
      expect(entry.plan).toEqual([]);
    }
  });
});

describe("copilot eval deterministic run", () => {
  const cases = parseCopilotEvalCases(copilotEvalCases);

  it("passes every case against the real catalog", { timeout: 60_000 }, async () => {
    const { reports, outcomes } = await runCopilotEvalSuite(
      cases,
      { run: runCopilotEvalCaseDeterministically },
      { fidelity: "deterministic" },
    );

    const notPassing = reports
      .filter((report) => report.status !== "pass")
      .map((report) => `${report.caseId}: ${report.status} — ${report.reason ?? ""}`);
    expect(notPassing).toEqual([]);
    expect(copilotHardGateViolations(cases, outcomes)).toEqual([]);
  });

  it("fails a case whose plan names a tool the catalog no longer offers", async () => {
    // This is the regression the deterministic layer exists to catch. A renamed tool, a tightened
    // input schema, or a descriptor requiring a permission the turn route never resolves all reach
    // the runtime as a rejected call — all three have shipped to main before.
    const observed = await runCopilotEvalCaseDeterministically(
      evalCase({ id: "renamed", plan: [{ tool: "workspace_triage_v2", input: {} }] }),
    );

    expect(observed.toolCalls).toEqual([
      expect.objectContaining({ tool: "workspace_triage_v2", status: "rejected", detail: expect.stringContaining("unknown_tool") }),
    ]);
    expect(scoreCopilotTurn([{ type: "tool_called", tool: "workspace_triage_v2" }], observed, "deterministic").status).toBe("fail");
  });

  it("fails a case whose operator lacks the permission the tool requires", async () => {
    const observed = await runCopilotEvalCaseDeterministically(
      evalCase({ id: "unpermitted", permissions: ["workspace.agents.read"], plan: [{ tool: "workspace_triage", input: {} }] }),
    );

    expect(observed.exposedTools).not.toContain("workspace_triage");
    expect(scoreCopilotTurn([{ type: "tool_called", tool: "workspace_triage" }], observed, "deterministic").status).toBe("fail");
  });
});
