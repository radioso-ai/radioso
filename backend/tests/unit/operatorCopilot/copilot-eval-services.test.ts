import { describe, expect, it, vi } from "vitest";

import type { AbuseControlPort } from "../../../src/modules/security/contracts/abuseControl.js";
import { MAX_COPILOT_EVAL_SUITE_CASES } from "../../../src/modules/operatorCopilot/contracts/evalCases.js";
import { EvalCaseCaptureService } from "../../../src/modules/operatorCopilot/services/evalCaseCaptureService.js";
import { EvalCaseReplayService } from "../../../src/modules/operatorCopilot/services/evalCaseReplayService.js";
import { EvalSuiteProbeService } from "../../../src/modules/operatorCopilot/services/evalSuiteProbeService.js";

const ids = {
  workspace: "00000000-0000-4000-8000-000000000001",
  account: "00000000-0000-4000-8000-000000000002",
  operator: "00000000-0000-4000-8000-000000000003",
  assistantMessage: "00000000-0000-4000-8000-000000000004",
  case: "00000000-0000-4000-8000-000000000005",
  snapshot: "00000000-0000-4000-8000-000000000006",
  agent: "00000000-0000-4000-8000-000000000007",
  run: "00000000-0000-4000-8000-000000000008",
  conversation: "00000000-0000-4000-8000-000000000009",
};

const subject = {
  workspaceId: ids.workspace,
  accountId: ids.account,
  operatorUserId: ids.operator,
};

const evalCase = (overrides: Record<string, unknown> = {}) => ({
  id: ids.case,
  sourceAgentId: ids.agent,
  workspaceId: ids.workspace,
  snapshotId: ids.snapshot,
  name: "2026-08-24 · \"Where is my order?\"",
  assertions: [],
  executionMode: "safe_test" as const,
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

  const harness = (options: { enforce?: AbuseControlPort["enforce"]; run?: () => Promise<unknown> } = {}) => {
    const order: string[] = [];
    const enforce = options.enforce ?? vi.fn(async () => {
      order.push("enforce");
      return undefined;
    });
    const run = (options.run ?? vi.fn(async () => {
      order.push("run");
      return suiteResult;
    })) as never;
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

    await expect(service.runCases({ ...subject, caseIds: [ids.case] })).rejects.toThrow(/do not retry this call in this turn/i);

    expect(run).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "security.rate_limit_enforced",
      eventStatus: "success",
      metadata: expect.objectContaining({ principalType: "operator_copilot", route: "run_eval_suite" }),
    }));
  });

  // Re-thrown by EvalSuiteService rather than scored as a per-case error, so it reaches the model
  // — which then needs to be told that waiting will not help, unlike a rate limit.
  it("turns an exhausted answer allowance into a refusal the model can act on", async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error("Usage limit exceeded"), { code: "usage_limit_exceeded", statusCode: 429 });
    });
    const { service } = harness({ run });

    await expect(service.runCases({ ...subject, caseIds: [ids.case] }))
      .rejects.toThrow(/do not retry this call or any other verification in this turn/i);
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

describe("copilot eval case replay", () => {
  const replayRun = (overrides: Record<string, unknown> = {}) => ({
    run: {
      status: "fail" as const,
      assertionVerdicts: [
        { assertion: { type: "answer_contains" }, status: "fail" as const, reason: "Answer omitted the refund window" },
      ],
      observedOutput: {
        answer: "I am not able to help with that.",
        groundingVerdict: "ungrounded",
        groundingDiagnostics: { unsupportedClaims: 1 },
      },
      resolvedConfig: { modelProvider: "openai", modelId: "gpt-test" },
      ...overrides,
    },
  });

  const harness = (options: {
    enforce?: AbuseControlPort["enforce"];
    findCase?: () => Promise<unknown>;
    execute?: () => Promise<unknown>;
  } = {}) => {
    const order: string[] = [];
    const enforce = options.enforce ?? vi.fn(async () => {
      order.push("enforce");
      return undefined;
    });
    const findCase = (options.findCase ?? vi.fn(async () => evalCase({ status: "failing", assertions: [{ type: "answer_contains" }] }))) as never;
    const execute = (options.execute ?? vi.fn(async () => {
      order.push("execute");
      return replayRun();
    })) as never;
    const record = vi.fn(async () => undefined);
    const service = new EvalCaseReplayService({
      cases: { findCase },
      runs: { execute },
      evidence: { record: vi.fn(async () => ({ id: "evidence-1" })), findMany: vi.fn() } as never,
      agentDirectives: { listDirectives: vi.fn(async () => []) },
      abuseControl: { enforce },
      audit: { record },
      abusePolicy: { limit: 30, windowMs: 3_600_000 },
    });
    return { service, findCase, execute, record, order, enforce };
  };

  it("replays the case's snapshot without recording the outcome against the case", async () => {
    const { service, execute } = harness();

    const result = await service.replayCase({ ...subject, caseId: ids.case, copilotConversationId: ids.conversation });

    expect(execute).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      accountId: ids.account,
      snapshotId: ids.snapshot,
      caseId: ids.case,
      mode: "full_assistant",
      overrides: undefined,
      attachToCase: false,
    });
    // The verdict this configuration produced, next to the verdict the library still holds.
    expect(result).toMatchObject({
      caseId: ids.case,
      verdict: "fail",
      recordedStatus: "failing",
      assertionCount: 1,
      answer: "I am not able to help with that.",
      groundingVerdict: "ungrounded",
      model: { provider: "openai", id: "gpt-test" },
      error: null,
    });
  });

  it("spends the expensive-operation budget before replaying", async () => {
    const { service, order, enforce } = harness();

    await service.replayCase({ ...subject, caseId: ids.case, copilotConversationId: ids.conversation });

    expect(order).toEqual(["enforce", "execute"]);
    expect(enforce).toHaveBeenCalledWith({
      scope: "api.expensive_authenticated",
      subjectKey: `account:${ids.account}:workspace:${ids.workspace}:operator:${ids.operator}`,
      limit: 30,
      windowMs: 3_600_000,
    });
  });

  it("audits a rate-limited replay and never runs the turn", async () => {
    const enforce = vi.fn(async () => {
      throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
    });
    const { service, execute, record } = harness({ enforce });

    await expect(service.replayCase({ ...subject, caseId: ids.case, copilotConversationId: ids.conversation })).rejects.toThrow(/do not retry this call in this turn/i);

    expect(execute).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "security.rate_limit_enforced",
      metadata: expect.objectContaining({ principalType: "operator_copilot", route: "replay_eval_case" }),
    }));
  });

  it("refuses a case that does not belong to the workspace", async () => {
    const findCase = vi.fn(async () => null);
    const { service, execute } = harness({ findCase });

    await expect(service.replayCase({ ...subject, caseId: ids.case, copilotConversationId: ids.conversation })).rejects.toThrow("Eval case not found");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a failed turn as an error rather than as a failing verdict", async () => {
    const execute = vi.fn(async () => ({
      run: {
        id: ids.run,
        status: "error" as const,
        assertionVerdicts: [],
        observedOutput: { error: { message: "Model call timed out" } },
        resolvedConfig: {},
      },
    }));
    const { service } = harness({ execute });

    const result = await service.replayCase({ ...subject, caseId: ids.case, copilotConversationId: ids.conversation });

    expect(result).toMatchObject({
      verdict: "error",
      error: "Model call timed out",
      answer: null,
      groundingVerdict: null,
      model: { provider: null, id: null },
    });
  });

  it("forwards the proposed configuration to the run", async () => {
    const { service, execute } = harness();
    const overrides = { agentConfigOverride: { customInstruction: "Always state the refund window." } };

    await service.replayCase({ ...subject, caseId: ids.case, copilotConversationId: ids.conversation, overrides });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ overrides }));
  });
});

describe("copilot eval case replay verdict projection", () => {
  it("reports a failed turn as an error even when the case has nothing to score", async () => {
    // combineVerdicts([]) is "recorded", which is the eval module's word for "no assertions ran".
    // A turn that never produced an answer is not unscored, and a freshly captured case has no
    // assertions yet — so the capture-then-replay path hits this on every model failure.
    const findCase = vi.fn(async () => evalCase({ status: "pending", assertions: [] }));
    const execute = vi.fn(async () => ({
      run: {
        id: ids.run,
        status: "recorded" as const,
        assertionVerdicts: [],
        observedOutput: { error: { message: "Model call timed out" } },
        resolvedConfig: {},
      },
    }));
    const service = new EvalCaseReplayService({
      cases: { findCase } as never,
      runs: { execute },
      evidence: { record: vi.fn(async () => ({ id: "evidence-1" })), findMany: vi.fn() } as never,
      agentDirectives: { listDirectives: vi.fn(async () => []) },
      abuseControl: { enforce: vi.fn(async () => undefined) },
      audit: { record: vi.fn(async () => undefined) },
      abusePolicy: { limit: 30, windowMs: 3_600_000 },
    });

    const result = await service.replayCase({ ...subject, caseId: ids.case, copilotConversationId: ids.conversation });

    expect(result).toMatchObject({ verdict: "error", error: "Model call timed out", assertionCount: 0 });
  });

  it("keeps an unscored but successful replay as recorded", async () => {
    const findCase = vi.fn(async () => evalCase({ status: "pending", assertions: [] }));
    const execute = vi.fn(async () => ({
      run: {
        id: ids.run,
        status: "recorded" as const,
        assertionVerdicts: [],
        observedOutput: { answer: "Refunds take 30 days." },
        resolvedConfig: {},
      },
    }));
    const service = new EvalCaseReplayService({
      cases: { findCase } as never,
      runs: { execute },
      evidence: { record: vi.fn(async () => ({ id: "evidence-1" })), findMany: vi.fn() } as never,
      agentDirectives: { listDirectives: vi.fn(async () => []) },
      abuseControl: { enforce: vi.fn(async () => undefined) },
      audit: { record: vi.fn(async () => undefined) },
      abusePolicy: { limit: 30, windowMs: 3_600_000 },
    });

    const result = await service.replayCase({ ...subject, caseId: ids.case, copilotConversationId: ids.conversation });

    expect(result).toMatchObject({ verdict: "recorded", error: null, answer: "Refunds take 30 days." });
  });
});

describe("copilot eval case replay evidence", () => {
  const capturedAt = new Date("2026-08-25T10:00:00.000Z");

  const harness = (options: {
    sourceAgentId?: string | null;
    directives?: ReadonlyArray<{ id: string; config: Record<string, unknown> }>;
    snapshotAuthoredDirectives?: ReadonlyArray<Record<string, unknown>>;
  } = {}) => {
    const findCase = vi.fn(async () => ({
      id: ids.case,
      name: "Refund window",
      snapshotId: ids.snapshot,
      status: "failing" as const,
      assertions: [{ type: "answer_contains" }],
      sourceAgentId: options.sourceAgentId === undefined ? ids.agent : options.sourceAgentId,
      snapshotCapturedAt: capturedAt,
      snapshotAuthoredDirectives: options.snapshotAuthoredDirectives ?? [],
    }));
    const execute = vi.fn(async () => ({
      run: {
        id: ids.run,
        status: "pass" as const,
        assertionVerdicts: [],
        observedOutput: { answer: "Refunds take 30 days." },
        resolvedConfig: {},
      },
    }));
    const record = vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: "evidence-1", createdAt: new Date() }));
    const get = vi.fn(async () => ({ updatedAt: capturedAt }));
    const listDirectives = vi.fn(async () => options.directives ?? []);
    const service = new EvalCaseReplayService({
      cases: { findCase } as never,
      runs: { execute },
      evidence: { record, findMany: vi.fn() } as never,
      agentDirectives: { listDirectives },
      abuseControl: { enforce: vi.fn(async () => undefined) },
      audit: { record: vi.fn(async () => undefined) },
      abusePolicy: { limit: 30, windowMs: 3_600_000 },
    });
    return { service, record, get, execute, listDirectives };
  };

  it("records what it measured so a later proposal can cite it", async () => {
    const { service, record } = harness();
    const overrides = { agentConfigOverride: { customInstruction: "State the refund window." } };

    const result = await service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    });

    expect(record).toHaveBeenCalledWith({
      workspaceId: ids.workspace,
      operatorUserId: ids.operator,
      conversationId: ids.conversation,
      agentId: ids.agent,
      caseId: ids.case,
      caseName: "Refund window",
      runId: ids.run,
      baselineCapturedAt: capturedAt,
      recordedStatus: "failing",
      verdict: "pass",
      overrides,
      directivesExcluded: [],
    });
    expect(result.evidenceId).toBe("evidence-1");
  });

  it("reports no evidence for a snapshot that captured no agent, rather than inventing one", async () => {
    // Without a captured agent there is nothing to attribute the measurement to and no capture
    // point to date it against, so the replay stays usable but is not citable.
    const { service, record } = harness({ sourceAgentId: null });

    const result = await service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
    });

    expect(record).not.toHaveBeenCalled();
    expect(result.evidenceId).toBeNull();
  });

  it("resolves excludedDirectiveIds against the source agent's real directives before running the replay", async () => {
    // The server — not the model — decides what "run without this directive" resolves to, so the
    // authoredDirectives array the run and the evidence row actually see is server-computed.
    const kept = { id: "directive-kept", config: { name: "Keep answering refunds" } };
    const removed = { id: "directive-removed", config: { name: "State the refund window" } };
    const { service, execute, record, listDirectives } = harness({
      directives: [kept, removed],
      snapshotAuthoredDirectives: [kept.config, removed.config],
    });
    const overrides = { agentConfigOverride: { excludedDirectiveIds: ["directive-removed"] } };

    await service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    });

    expect(listDirectives).toHaveBeenCalledWith(ids.workspace, ids.agent);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      overrides: { agentConfigOverride: { authoredDirectives: [kept.config] } },
    }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      overrides: { agentConfigOverride: { authoredDirectives: [kept.config] } },
      directivesExcluded: ["directive-removed"],
    }));
  });

  it("replays the snapshot's own directive content, not the agent's current directives, so unrelated live edits since capture cannot leak into the measurement", async () => {
    // `kept` differs between live and the snapshot — an edit an operator made to an unrelated
    // directive sometime after this case was captured. The replay must reflect what the snapshot
    // saw (`keptAtCapture`), never the live edit, or an improvement could get credited to the
    // directive removal when it was really caused by this unrelated change.
    const keptLive = { id: "directive-kept", config: { name: "Keep answering refunds", action: "Edited after capture" } };
    const keptAtCapture = { name: "Keep answering refunds", action: "Original action at capture" };
    const removed = { id: "directive-removed", config: { name: "State the refund window", action: "Say 30 days" } };
    const { service, execute, record } = harness({
      directives: [keptLive, removed],
      snapshotAuthoredDirectives: [keptAtCapture, removed.config],
    });
    const overrides = { agentConfigOverride: { excludedDirectiveIds: ["directive-removed"] } };

    await service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      overrides: { agentConfigOverride: { authoredDirectives: [keptAtCapture] } },
    }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      overrides: { agentConfigOverride: { authoredDirectives: [keptAtCapture] } },
    }));
  });

  it("refuses excludedDirectiveIds when the named directive is not present in the case's captured snapshot", async () => {
    // The directive exists on the live agent but was created after this case's snapshot was
    // captured, so there is nothing in the snapshot to remove — silently ignoring the exclusion
    // would credit the removal for a directive the captured "before" verdict never saw.
    const addedSinceCapture = { id: "directive-new", config: { name: "New directive since capture" } };
    const { service, execute } = harness({
      directives: [addedSinceCapture],
      snapshotAuthoredDirectives: [],
    });
    const overrides = { agentConfigOverride: { excludedDirectiveIds: ["directive-new"] } };

    await expect(service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    })).rejects.toThrow(/not present in this case's captured snapshot/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses excludedDirectiveIds when the live directive no longer matches what the snapshot captured", async () => {
    // Same name, live id still resolves — but the content was edited since capture. A rename or
    // edit that reuses the name must not slip through as "the same directive" the case measured.
    const editedLive = { id: "directive-removed", config: { name: "State the refund window", action: "Say 45 days" } };
    const capturedVersion = { name: "State the refund window", action: "Say 30 days" };
    const { service, execute } = harness({
      directives: [editedLive],
      snapshotAuthoredDirectives: [capturedVersion],
    });
    const overrides = { agentConfigOverride: { excludedDirectiveIds: ["directive-removed"] } };

    await expect(service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    })).rejects.toThrow(/changed since this case's snapshot was captured/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("still excludes a directive whose snapshot was captured before directives carried an enabled flag", async () => {
    // A case captured before the field existed simply omits it, while live serialization always
    // states it. Comparing those directly would call every pre-existing case's directives
    // "changed since capture" and refuse a replay that is perfectly honest.
    const live = { id: "directive-removed", config: { name: "State the refund window", action: "Say 30 days", enabled: true } };
    const capturedBeforeTheField = { name: "State the refund window", action: "Say 30 days" };
    const { service, execute } = harness({
      directives: [live],
      snapshotAuthoredDirectives: [capturedBeforeTheField],
    });
    const overrides = { agentConfigOverride: { excludedDirectiveIds: ["directive-removed"] } };

    await service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    });

    expect(execute).toHaveBeenCalled();
  });

  it("still refuses a directive turned off since a snapshot captured before the enabled flag existed", async () => {
    // Absent means enabled, so an operator disabling the directive after capture is a real change
    // to what the case measured — the defaulting must not swallow that.
    const live = { id: "directive-removed", config: { name: "State the refund window", action: "Say 30 days", enabled: false } };
    const capturedBeforeTheField = { name: "State the refund window", action: "Say 30 days" };
    const { service, execute } = harness({
      directives: [live],
      snapshotAuthoredDirectives: [capturedBeforeTheField],
    });
    const overrides = { agentConfigOverride: { excludedDirectiveIds: ["directive-removed"] } };

    await expect(service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    })).rejects.toThrow(/changed since this case's snapshot was captured/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an excludedDirectiveIds entry that is not one of the source agent's real directives", async () => {
    const { service, execute } = harness({ directives: [{ id: "directive-kept", config: {} }] });
    const overrides = { agentConfigOverride: { excludedDirectiveIds: ["not-a-real-directive"] } };

    await expect(service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    })).rejects.toThrow(/cannot exclude directive/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses excludedDirectiveIds combined with a hand-authored authoredDirectives override", async () => {
    const { service, execute } = harness({ directives: [{ id: "directive-kept", config: {} }] });
    const overrides = {
      agentConfigOverride: {
        excludedDirectiveIds: ["directive-kept"],
        authoredDirectives: [{ action: "Anything" }],
      },
    };

    await expect(service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    })).rejects.toThrow(/cannot be combined/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses excludedDirectiveIds when the case has no source agent to resolve them against", async () => {
    const { service, execute } = harness({ sourceAgentId: null });
    const overrides = { agentConfigOverride: { excludedDirectiveIds: ["directive-removed"] } };

    await expect(service.replayCase({
      ...subject,
      caseId: ids.case,
      copilotConversationId: ids.conversation,
      overrides,
    })).rejects.toThrow(/no source agent/i);
    expect(execute).not.toHaveBeenCalled();
  });
});
