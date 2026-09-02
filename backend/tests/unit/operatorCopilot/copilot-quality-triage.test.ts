import { describe, expect, it, vi } from "vitest";

import { createQualityTriageCopilotTools } from "../../../src/modules/operatorCopilot/tools/quality.js";
import type { CopilotQualityTriagePort, QualityTriageCopilotToolDependencies } from "../../../src/modules/operatorCopilot/tools/quality.js";

const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "quality" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const record = (overrides: Record<string, unknown> = {}) => ({
  state: "resolved",
  version: 4,
  resolution: { reason: "knowledge_gap", note: "Added the shipping page." },
  closedAt: "2026-08-26T10:00:00.000Z",
  updatedAt: "2026-08-26T10:00:00.000Z",
  ...overrides,
});

const dependencies = (
  setTriageState: CopilotQualityTriagePort["setTriageState"] = vi.fn(async () => ({ kind: "updated" as const, record: record() })),
): QualityTriageCopilotToolDependencies => ({
  auditService: { record: vi.fn(async () => undefined) },
  qualityTriageService: {
    triageStates: ["open", "acknowledged", "resolved", "dismissed"] as const,
    resolutionReasons: ["knowledge_gap", "retrieval_issue", "expected_behavior"] as const,
    setTriageState,
  },
} as unknown as QualityTriageCopilotToolDependencies);

const invoke = (deps: QualityTriageCopilotToolDependencies, input: Record<string, unknown>) => {
  const [descriptor] = createQualityTriageCopilotTools(deps);
  return descriptor!.createTool(context).invoke(input as never, {} as never) as Promise<Record<string, unknown>>;
};

describe("set_triage_state", () => {
  it("declares an act that carries the quality manage grant", () => {
    const [descriptor] = createQualityTriageCopilotTools(dependencies());

    expect(descriptor).toMatchObject({
      name: "set_triage_state",
      shape: "act",
      contributingModule: "quality",
      requiredPermissions: ["workspace.quality.manage"],
      dashboardSubject: { type: "quality_turn" },
    });
  });

  it("transitions the turn with the version the operator read and attributes the operator", async () => {
    const setTriageState = vi.fn(async () => ({ kind: "updated" as const, record: record() }));

    const result = await invoke(dependencies(setTriageState), {
      assistantMessageId: MESSAGE_ID,
      state: "resolved",
      expectedVersion: 3,
      resolution: { reason: "knowledge_gap", note: "Added the shipping page." },
    });

    expect(setTriageState).toHaveBeenCalledWith("workspace-1", {
      assistantMessageId: MESSAGE_ID,
      state: "resolved",
      expectedVersion: 3,
      resolution: { reason: "knowledge_gap", note: "Added the shipping page." },
      updatedBy: "operator-1",
    });
    expect(result).toMatchObject({
      outcome: "updated",
      state: "resolved",
      version: 4,
      resolution: { reason: "knowledge_gap", note: "Added the shipping page." },
    });
  });

  it("records which Ray turn moved the row, and does not call a conflict a transition", async () => {
    const deps = dependencies(vi.fn(async () => ({
      kind: "conflict" as const,
      current: record({ state: "dismissed", version: 9 }),
    })));

    await invoke(deps, { assistantMessageId: MESSAGE_ID, state: "resolved", expectedVersion: 3 });

    expect(deps.auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      eventType: "copilot.triage.transitioned",
      eventStatus: "failure",
      metadata: expect.objectContaining({
        assistantMessageId: MESSAGE_ID,
        outcome: "conflict",
        operatorUserId: "operator-1",
        surface: "dashboard",
      }),
    }));
  });

  it("reports a competing operator's write as a conflict carrying the current record", async () => {
    const setTriageState = vi.fn(async () => ({
      kind: "conflict" as const,
      current: record({ state: "dismissed", version: 9, resolution: { reason: "expected_behavior", note: null } }),
    }));

    const result = await invoke(dependencies(setTriageState), {
      assistantMessageId: MESSAGE_ID,
      state: "resolved",
      expectedVersion: 3,
    });

    // A conflict is an answer, not a failure: Ray has to see the row it lost to before deciding.
    expect(result).toMatchObject({ outcome: "conflict", state: "dismissed", version: 9 });
    expect(setTriageState).toHaveBeenCalledTimes(1);
  });

  it("fails when the turn does not exist in the workspace", async () => {
    const setTriageState = vi.fn(async () => ({ kind: "not_found" as const }));

    await expect(invoke(dependencies(setTriageState), {
      assistantMessageId: MESSAGE_ID,
      state: "acknowledged",
      expectedVersion: 0,
    })).rejects.toThrow(/not found/i);
  });

  it("accepts only the resolution vocabulary the quality module declares", () => {
    const [descriptor] = createQualityTriageCopilotTools(dependencies());

    expect(descriptor!.inputSchema.safeParse({
      assistantMessageId: MESSAGE_ID,
      state: "resolved",
      expectedVersion: 1,
      resolution: { reason: "knowledge_gap" },
    }).success).toBe(true);
    // The vocabulary reaches the schema through the port, so the catalog never keeps its own copy.
    expect(descriptor!.inputSchema.safeParse({
      assistantMessageId: MESSAGE_ID,
      state: "resolved",
      expectedVersion: 1,
      resolution: { reason: "made_up_reason" },
    }).success).toBe(false);
  });

  it("requires the observed version, because an optional fence is no fence", () => {
    const [descriptor] = createQualityTriageCopilotTools(dependencies());

    // Made optional with a zero default, every stale transition would win against an untriaged row
    // and no other test in this file would notice.
    expect(descriptor!.inputSchema.safeParse({
      assistantMessageId: MESSAGE_ID,
      state: "acknowledged",
    }).success).toBe(false);
  });

  it("takes the state vocabulary from the quality module rather than keeping its own copy", () => {
    // A deliberately different vocabulary: a hardcoded copy of the real four states would accept
    // "acknowledged" and reject "escalated", which is the inverse of what the port declares here.
    const deps = dependencies();
    (deps.qualityTriageService as { triageStates: readonly string[] }).triageStates = ["open", "escalated"];
    const [descriptor] = createQualityTriageCopilotTools(deps);

    expect(descriptor!.inputSchema.safeParse({
      assistantMessageId: MESSAGE_ID, state: "escalated", expectedVersion: 1,
    }).success).toBe(true);
    expect(descriptor!.inputSchema.safeParse({
      assistantMessageId: MESSAGE_ID, state: "acknowledged", expectedVersion: 1,
    }).success).toBe(false);
  });

  it("leaves state-to-reason compatibility to the quality module rather than restating it", async () => {
    // `expected_behavior` is a dismissal reason. The catalog forwards it and the owning module
    // rejects it, so the pairing rules live in exactly one place.
    const setTriageState = vi.fn(async () => { throw new Error("Resolution reason is not valid for the resolved state"); });

    await expect(invoke(dependencies(setTriageState), {
      assistantMessageId: MESSAGE_ID,
      state: "resolved",
      expectedVersion: 1,
      resolution: { reason: "expected_behavior" },
    })).rejects.toThrow(/not valid for the resolved state/);
    expect(setTriageState).toHaveBeenCalledTimes(1);
  });
});
