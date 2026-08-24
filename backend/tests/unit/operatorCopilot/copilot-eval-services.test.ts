import { describe, expect, it, vi } from "vitest";

import type { AbuseControlPort } from "../../../src/modules/security/contracts/abuseControl.js";
import { MAX_COPILOT_EVAL_SUITE_CASES } from "../../../src/modules/operatorCopilot/contracts/evalCases.js";
import { EvalCaseCaptureService } from "../../../src/modules/operatorCopilot/services/evalCaseCaptureService.js";
import { EvalSuiteProbeService } from "../../../src/modules/operatorCopilot/services/evalSuiteProbeService.js";

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  account: "00000000-0000-4000-8000-000000000002",
  operator: "00000000-0000-4000-8000-000000000003",
  assistantMessage: "00000000-0000-4000-8000-000000000004",
  case: "00000000-0000-4000-8000-000000000005",
  snapshot: "00000000-0000-4000-8000-000000000006",
};

const subject = {
  workspaceId: ids.workspace,
  accountId: ids.account,
  operatorUserId: ids.operator,
};

const evalCase = (overrides: Record<string, unknown> = {}) => ({
  id: ids.case,
  workspaceId: ids.workspace,
  snapshotId: ids.snapshot,
  name: "2026-08-24 · \"Where is my order?\"",
  assertions: [],
  status: "pending" as const,
  lastRunId: null,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:00:00.000Z",
  ...overrides,
});

describe("copilot eval case capture", () => {
  it("captures the turn under the operator's identity and projects the case", async () => {
    const findOrCreate = vi.fn(async () => ({ case: evalCase(), created: true }));
    const record = vi.fn(async () => undefined);
    const service = new EvalCaseCaptureService({ messageCases: { findOrCreate }, audit: { record } });

    const result = await service.captureFromTurn({ ...subject, assistantMessageId: ids.assistantMessage });

    expect(findOrCreate).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      assistantMessageId: ids.assistantMessage,
      createdBy: ids.operator,
    });
    expect(result).toEqual({
      caseId: ids.case,
      name: "2026-08-24 · \"Where is my order?\"",
      snapshotId: ids.snapshot,
      status: "pending",
      assertionCount: 0,
      created: true,
    });
  });

  it("audits the capture as an eval case creation attributed to Ray", async () => {
    const findOrCreate = vi.fn(async () => ({ case: evalCase(), created: true }));
    const record = vi.fn(async () => undefined);
    const service = new EvalCaseCaptureService({ messageCases: { findOrCreate }, audit: { record } });

    await service.captureFromTurn({ ...subject, assistantMessageId: ids.assistantMessage });

    expect(record).toHaveBeenCalledWith({
      accountId: ids.account,
      workspaceId: ids.workspace,
      eventType: "eval.case.create",
      eventStatus: "success",
      metadata: {
        caseId: ids.case,
        assistantMessageId: ids.assistantMessage,
        principalType: "operator_copilot",
        route: "create_eval_case_from_turn",
      },
    });
  });

  it("does not audit a repeat capture, which changes nothing", async () => {
    const findOrCreate = vi.fn(async () => ({
      case: evalCase({ assertions: [{ type: "answer_contains" }, { type: "answer_cites_document" }], status: "failing" }),
      created: false,
    }));
    const record = vi.fn(async () => undefined);
    const service = new EvalCaseCaptureService({ messageCases: { findOrCreate }, audit: { record } });

    const result = await service.captureFromTurn({ ...subject, assistantMessageId: ids.assistantMessage });

    expect(record).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: false, assertionCount: 2, status: "failing" });
  });
});

describe("copilot eval suite probe", () => {
  const suiteResult = {
    results: [{ caseId: ids.case, name: "Refund window", status: "pass" as const, error: null, run: null }],
    summary: { total: 1, scored: 1, passing: 1, failing: 0, error: 0, pending: 0, unscored: 0 },
  };

  const harness = (options: { enforce?: AbuseControlPort["enforce"] } = {}) => {
    const order: string[] = [];
    const enforce = options.enforce ?? vi.fn(async () => {
      order.push("enforce");
      return undefined;
    });
    const run = vi.fn(async () => {
      order.push("run");
      return suiteResult;
    });
    const record = vi.fn(async () => undefined);
    const service = new EvalSuiteProbeService({
      suite: { run },
      abuseControl: { enforce },
      audit: { record },
      abusePolicy: { limit: 30, windowMs: 3_600_000 },
    });
    return { service, run, record, order, enforce };
  };

  it("spends the expensive-operation budget before running any case", async () => {
    const { service, run, order, enforce } = harness();

    const result = await service.runCases({ ...subject, caseIds: [ids.case], mode: "full_assistant" });

    expect(order).toEqual(["enforce", "run"]);
    expect(enforce).toHaveBeenCalledWith({
      scope: "api.expensive_authenticated",
      subjectKey: `account:${ids.account}:workspace:${ids.workspace}:operator:${ids.operator}`,
      limit: 30,
      windowMs: 3_600_000,
    });
    expect(run).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      accountId: ids.account,
      caseIds: [ids.case],
      mode: "full_assistant",
    });
    expect(result).toEqual(suiteResult);
  });

  it("audits a rate-limited run and surfaces the refusal", async () => {
    const enforce = vi.fn(async () => {
      throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
    });
    const { service, run, record } = harness({ enforce });

    await expect(service.runCases({ ...subject, caseIds: [ids.case] })).rejects.toThrow("Too many requests");

    expect(run).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "security.rate_limit_enforced",
      eventStatus: "success",
      metadata: expect.objectContaining({ principalType: "operator_copilot", route: "run_eval_suite" }),
    }));
  });

  it("refuses a selection larger than one call can finish", async () => {
    const { service, run } = harness();
    const caseIds = Array.from({ length: MAX_COPILOT_EVAL_SUITE_CASES + 1 }, (_, index) =>
      `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`);

    await expect(service.runCases({ ...subject, caseIds })).rejects.toThrow(
      `At most ${MAX_COPILOT_EVAL_SUITE_CASES} eval cases may be run in one call`,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("counts a repeated case once so the cap reflects real work", async () => {
    const { service, run } = harness();
    const caseIds = Array.from({ length: MAX_COPILOT_EVAL_SUITE_CASES + 1 }, () => ids.case);

    await service.runCases({ ...subject, caseIds });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ caseIds: [ids.case] }));
  });

  it("defaults to a full assistant run", async () => {
    const { service, run } = harness();

    await service.runCases({ ...subject, caseIds: [ids.case] });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ mode: "full_assistant" }));
  });
});
