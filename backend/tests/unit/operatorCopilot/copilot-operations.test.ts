import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  COPILOT_PROBE_BUDGET_PER_TURN_DEFAULT,
  MAX_COPILOT_EVAL_SUITE_CASES,
  OperatorCopilotService,
  type CopilotSurface,
  type CopilotToolDescriptor,
} from "../../../src/modules/operatorCopilot/public.js";
import { recordProposalCreated } from "../../../src/modules/operatorCopilot/tools/shared.js";
import { InMemoryCopilotRepository } from "../../support/inMemoryCopilotRepository.js";

const now = new Date("2026-08-31T00:00:00.000Z");
const workspaceRouteKeyResolver = { resolveWorkspaceKey: async () => "acme" };
const currentAuthorization = { hasAllPermissions: async () => true };
const usageLimitPolicy = () => ({
  reserveAnswer: vi.fn(async () => ({ commit: vi.fn(async () => {}), release: vi.fn(async () => {}) })),
  reserveDocument: vi.fn(),
  reserveIndexedStorage: vi.fn(),
  reserveMonthlyIndexedContent: vi.fn(),
});

const pageContext = { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] };

type AuditEvent = { eventType: string; eventStatus: string; metadata: Record<string, unknown> };
const auditSpy = () => vi.fn(async (_event: AuditEvent) => {});
const recorded = (spy: ReturnType<typeof auditSpy>): ReadonlyArray<AuditEvent> => spy.mock.calls.map(([event]) => event);

const descriptor = (
  name: string,
  shape: CopilotToolDescriptor["shape"],
  invoke: (input: unknown, ctx: unknown) => Promise<unknown>,
  verificationCost: number | ((input: unknown) => number) = 0,
): CopilotToolDescriptor => ({
  name,
  shape,
  verificationCost: typeof verificationCost === "function" ? verificationCost : () => verificationCost,
  uiLabel: name,
  description: name,
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  requiredPermissions: ["workspace.agents.read"] as const,
  contributingModule: "test",
  dashboardSubject: { type: "workspace" },
  createTool: () => ({ name, description: name, inputSchema: z.object({}), outputSchema: z.object({ value: z.string() }), invoke }),
});

const emptyStream = () => ({
  events: (async function* () {})(),
  result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: "Done", stepsTaken: 1, toolResultTokensUsed: 0, wallTimeMs: 1 }),
});

const buildService = (overrides: {
  repository?: InMemoryCopilotRepository;
  auditRecord?: ReturnType<typeof auditSpy>;
  tools?: ReadonlyArray<CopilotToolDescriptor>;
  probeBudgetPerTurn?: number;
  runStreaming?: (request: unknown, tools: ReadonlyArray<{ name: string; invoke: (input: unknown, ctx: unknown) => Promise<unknown> }>) => unknown;
} = {}) => {
  const repository = overrides.repository ?? new InMemoryCopilotRepository();
  const auditRecord = overrides.auditRecord ?? auditSpy();
  const service = new OperatorCopilotService({
    repository,
    capabilityRunner: { runStreaming: (overrides.runStreaming ?? emptyStream) as never },
    usageLimitPolicy: usageLimitPolicy(),
    auditService: { record: auditRecord },
    prompt: "system",
    workspaceRouteKeyResolver,
    currentAuthorization,
    tools: overrides.tools ?? [],
    ...(overrides.probeBudgetPerTurn === undefined ? {} : { probeBudgetPerTurn: overrides.probeBudgetPerTurn }),
    now: () => now,
  });
  return { service, repository, auditRecord };
};

const runTurn = async (service: OperatorCopilotService, surface: CopilotSurface = "dashboard") => {
  const events = [];
  for await (const event of service.runTurn({
    workspaceId: "workspace",
    accountId: "account",
    operatorUserId: "operator",
    surface,
    conversationId: null,
    message: "Check the agent",
    pageContext,
    permissions: new Set(["workspace.agents.read", "workspace.agents.manage"]),
  })) events.push(event);
  return events;
};

describe("copilot recovery failure", () => {
  it("audits a failed closing call so a blank turn is distinguishable from a silent model", async () => {
    // The runtime suppresses the failure so the run ends on its own terms, and the trace dies with
    // the request. Without a durable record, support sees an operator complaining about a blank
    // answer and nothing at all on the server.
    const { service, auditRecord } = buildService({
      runStreaming: () => ({
        events: (async function* () {
          yield { kind: "model_call_failed", stepIndex: 3, phase: "closing_message", error: "provider exploded", at: 1 };
        })(),
        result: Promise.resolve({ terminatedReason: "tool_validation_failed" as const, finalMessage: null, stepsTaken: 3, toolResultTokensUsed: 0, wallTimeMs: 1 }),
      }),
    });

    await runTurn(service);

    expect(auditRecord.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        eventType: "copilot.turn.recovery_failed",
        eventStatus: "failure",
        metadata: expect.objectContaining({ phase: "closing_message", error: "provider exploded" }),
      }),
    );
  });
});

describe("copilot audit attribution", () => {
  it("stamps the operator principal and the calling surface on every copilot.* turn event", async () => {
    const { service, auditRecord } = buildService();

    await runTurn(service);

    const copilotEvents = recorded(auditRecord);
    expect(copilotEvents.map((event) => event.eventType)).toEqual(["copilot.turn.started", "copilot.turn.completed"]);
    for (const event of copilotEvents) {
      expect(event.metadata).toMatchObject({ surface: "dashboard", operatorUserId: "operator" });
    }
  });

  it("records the surface the turn actually came from rather than a default", async () => {
    const { service, auditRecord } = buildService();

    await runTurn(service, "mcp");

    for (const event of recorded(auditRecord)) {
      expect(event.metadata).toMatchObject({ surface: "mcp" });
    }
  });

  it("attributes a failed turn to its operator and surface", async () => {
    const { service, auditRecord } = buildService({
      runStreaming: () => {
        throw new Error("runner exploded");
      },
    });

    await runTurn(service, "mcp");

    const failure = recorded(auditRecord).find((event) => event.eventType === "copilot.turn.failed");
    expect(failure?.metadata).toMatchObject({ surface: "mcp", operatorUserId: "operator" });
  });

  it("attributes proposal apply and dismiss to their operator and surface", async () => {
    const repository = new InMemoryCopilotRepository();
    const auditRecord = auditSpy();
    const conversation = await repository.createConversation({ workspaceId: "workspace", operatorUserId: "operator", title: "t" });
    const makeProposal = () => repository.createProposal({
      workspaceId: "workspace",
      operatorUserId: "operator",
      conversationId: conversation.id,
      targetType: "directive",
      targetRef: { agentId: "agent-1" },
      payload: { name: "Example" },
      versionToken: "v1",
      evidence: null,
    });
    const applied = await makeProposal();
    const dismissed = await makeProposal();
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: { runStreaming: emptyStream },
      usageLimitPolicy: usageLimitPolicy(),
      auditService: { record: auditRecord },
      prompt: "system",
      workspaceRouteKeyResolver,
      currentAuthorization,
      tools: [],
      proposalAdapters: [{
        targetType: "directive",
        preview: async () => ({ targetLabel: "Example", current: null, proposed: {} }),
        readVersionToken: async () => "v1",
        applyIfVersionMatches: async () => ({ outcome: "applied" as const, appliedRef: { id: "directive-1" } }),
      }],
      now: () => now,
    });

    await service.applyProposal({ workspaceId: "workspace", accountId: "account", operatorUserId: "operator", surface: "dashboard", proposalId: applied.id });
    await service.dismissProposal({ workspaceId: "workspace", accountId: "account", operatorUserId: "operator", surface: "mcp", proposalId: dismissed.id });

    const events = recorded(auditRecord);
    expect(events.find((event) => event.eventType === "copilot.proposal.applied")?.metadata)
      .toMatchObject({ surface: "dashboard", operatorUserId: "operator" });
    expect(events.find((event) => event.eventType === "copilot.proposal.dismissed")?.metadata)
      .toMatchObject({ surface: "mcp", operatorUserId: "operator" });
  });

  it("attributes a proposal drafted during a turn, not only the apply that follows it", async () => {
    // Drafting is the act Ray performs; applying is the operator's. An audit trail that can name
    // who applied a change but not which transport drafted it answers the wrong half. The tool
    // records this one itself, so the surface has to reach the tool's context rather than stopping
    // at the service.
    const auditRecord = auditSpy();
    const draft: CopilotToolDescriptor = {
      ...descriptor("propose_directive", "propose", async () => ({ value: "ok" })),
      createTool: (toolContext) => ({
        name: "propose_directive",
        description: "propose_directive",
        inputSchema: z.object({}),
        outputSchema: z.object({ value: z.string() }),
        invoke: async () => {
          await recordProposalCreated(
            { record: auditRecord },
            toolContext,
            { id: "proposal-1", targetType: "directive" } as never,
          );
          return { value: "ok" };
        },
      }),
    };
    const { service } = buildService({
      auditRecord,
      tools: [draft],
      runStreaming: (_request, tools) => ({
        events: (async function* () {
          await tools.find((candidate) => candidate.name === "propose_directive")!
            .invoke({}, { signal: new AbortController().signal, stepIndex: 0, callId: "call-0" });
        })(),
        result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: "Done", stepsTaken: 1, toolResultTokensUsed: 1, wallTimeMs: 1 }),
      }),
    });

    await runTurn(service, "mcp");

    const created = recorded(auditRecord).find((event) => event.eventType === "copilot.proposal.created");
    expect(created?.metadata).toMatchObject({ surface: "mcp", operatorUserId: "operator" });
  });

  it("attributes an authorization denial to the operator who was refused", async () => {
    const repository = new InMemoryCopilotRepository();
    const auditRecord = auditSpy();
    const conversation = await repository.createConversation({ workspaceId: "workspace", operatorUserId: "operator", title: "t" });
    const proposal = await repository.createProposal({
      workspaceId: "workspace",
      operatorUserId: "operator",
      conversationId: conversation.id,
      targetType: "directive",
      targetRef: { agentId: "agent-1" },
      payload: { name: "Example" },
      versionToken: "v1",
      evidence: null,
    });
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner: { runStreaming: emptyStream },
      usageLimitPolicy: usageLimitPolicy(),
      auditService: { record: auditRecord },
      prompt: "system",
      workspaceRouteKeyResolver,
      currentAuthorization: { hasAllPermissions: async () => false },
      tools: [],
      now: () => now,
    });

    await expect(service.applyProposal({ workspaceId: "workspace", accountId: "account", operatorUserId: "operator", surface: "mcp", proposalId: proposal.id }))
      .rejects.toThrow();

    expect(recorded(auditRecord)[0])
      .toMatchObject({ eventType: "copilot.proposal.apply_denied", metadata: { surface: "mcp", operatorUserId: "operator" } });
  });
});

describe("copilot per-turn probe budget", () => {
  const streamInvoking = (toolName: string, callCount: number) =>
    (_request: unknown, tools: ReadonlyArray<{ name: string; invoke: (input: unknown, ctx: unknown) => Promise<unknown> }>) => {
      const target = tools.find((candidate) => candidate.name === toolName)!;
      return {
        events: (async function* () {
          for (let index = 0; index < callCount; index += 1) {
            try {
              await target.invoke({}, { signal: new AbortController().signal, stepIndex: index, callId: `call-${index}` });
              yield { kind: "tool_call_completed" as const, stepIndex: index, toolName, callId: `call-${index}`, output: { value: "ok" }, resultTokens: 1, latencyMs: 1, at: index };
            } catch (error) {
              yield { kind: "tool_call_failed" as const, stepIndex: index, toolName, callId: `call-${index}`, error: error instanceof Error ? error.message : String(error), latencyMs: 1, at: index };
            }
          }
        })(),
        result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: "Done", stepsTaken: callCount, toolResultTokensUsed: 1, wallTimeMs: 1 }),
      };
    };

  it("refuses a probe past the turn budget with wording the model can act on", async () => {
    const invoke = vi.fn(async () => ({ value: "ok" }));
    const { service } = buildService({
      tools: [descriptor("replay_eval_case", "probe", invoke, 1)],
      probeBudgetPerTurn: 2,
      runStreaming: streamInvoking("replay_eval_case", 4),
    });

    const events = await runTurn(service);

    expect(invoke).toHaveBeenCalledTimes(2);
    const failures = events.filter((event) => event.event === "activity" && (event.data as { stage?: string }).stage === "failed");
    expect(failures).toHaveLength(2);
  });

  it("surfaces the exhausted budget as a refusal that tells the model not to retry this turn", async () => {
    const errors: string[] = [];
    const { service } = buildService({
      tools: [descriptor("replay_eval_case", "probe", vi.fn(async () => ({ value: "ok" })), 1)],
      probeBudgetPerTurn: 1,
      runStreaming: (_request, tools) => {
        const target = tools.find((candidate) => candidate.name === "replay_eval_case")!;
        return {
          events: (async function* () {
            await target.invoke({}, { signal: new AbortController().signal, stepIndex: 0, callId: "call-0" });
            try {
              await target.invoke({}, { signal: new AbortController().signal, stepIndex: 1, callId: "call-1" });
            } catch (error) {
              errors.push(error instanceof Error ? error.message : String(error));
            }
          })(),
          result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: "Done", stepsTaken: 2, toolResultTokensUsed: 1, wallTimeMs: 1 }),
        };
      },
    });

    await runTurn(service);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("1");
    expect(errors[0]).toMatch(/do not retry/i);
    expect(errors[0]).toMatch(/new (copilot )?turn/i);
  });

  it("spends the budget per turn, not per conversation", async () => {
    const invoke = vi.fn(async () => ({ value: "ok" }));
    const { service } = buildService({
      tools: [descriptor("replay_eval_case", "probe", invoke, 1)],
      probeBudgetPerTurn: 1,
      runStreaming: streamInvoking("replay_eval_case", 1),
    });

    await runTurn(service);
    await runTurn(service);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("leaves a tool that costs nothing unmetered, whatever its shape", async () => {
    const reads = vi.fn(async () => ({ value: "ok" }));
    const { service } = buildService({
      tools: [descriptor("agent_configuration", "read", reads, 0)],
      probeBudgetPerTurn: 1,
      runStreaming: streamInvoking("agent_configuration", 5),
    });

    await runTurn(service);

    expect(reads).toHaveBeenCalledTimes(5);
  });

  // The defect this replaced: the budget keyed on `shape: "probe"`, but `run_eval_suite` is an
  // `act` (it moves a case's stored verdict) and replays up to five cases a call — so the most
  // expensive tool in the catalog was the one shape-based metering let through untouched.
  it("meters an act-shaped tool that spends model budget", async () => {
    const invoke = vi.fn(async () => ({ value: "ok" }));
    const { service } = buildService({
      tools: [descriptor("run_eval_suite", "act", invoke, 1)],
      probeBudgetPerTurn: 2,
      runStreaming: streamInvoking("run_eval_suite", 4),
    });

    await runTurn(service);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("charges what the call will actually spend, not one unit per call", async () => {
    const invoke = vi.fn(async () => ({ value: "ok" }));
    const { service } = buildService({
      tools: [descriptor("run_eval_suite", "act", invoke, (input) => (input as { caseIds: string[] }).caseIds.length)],
      probeBudgetPerTurn: 5,
      runStreaming: (_request, tools) => {
        const target = tools.find((candidate) => candidate.name === "run_eval_suite")!;
        return {
          events: (async function* () {
            await target.invoke({ caseIds: ["a", "b", "c"] }, { signal: new AbortController().signal, stepIndex: 0, callId: "call-0" });
            try {
              await target.invoke({ caseIds: ["d", "e", "f"] }, { signal: new AbortController().signal, stepIndex: 1, callId: "call-1" });
            } catch { /* the refusal is what the assertion below checks */ }
          })(),
          result: Promise.resolve({ terminatedReason: "completed" as const, finalMessage: "Done", stepsTaken: 2, toolResultTokensUsed: 1, wallTimeMs: 1 }),
        };
      },
    });

    await runTurn(service);

    // Three of five spent, so a second three-case call would overshoot and never runs.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses a call whose whole cost overshoots, rather than letting it run and go negative", async () => {
    const invoke = vi.fn(async () => ({ value: "ok" }));
    const { service } = buildService({
      tools: [descriptor("run_eval_suite", "act", invoke, 5)],
      probeBudgetPerTurn: 3,
      runStreaming: streamInvoking("run_eval_suite", 1),
    });

    await runTurn(service);

    expect(invoke).not.toHaveBeenCalled();
  });

  // The type makes the declaration mandatory in-repo, which is only advice to a module compiled
  // elsewhere. These two are what keep the budget's guarantee independent of what a contributor
  // wrote: a cost that cannot be charged refuses the call rather than running it for free.
  it("refuses a tool whose declared cost is not a usable number", async () => {
    const invoke = vi.fn(async () => ({ value: "ok" }));
    const { service } = buildService({
      tools: [descriptor("run_eval_suite", "act", invoke, () => Number.NaN)],
      probeBudgetPerTurn: 6,
      runStreaming: streamInvoking("run_eval_suite", 1),
    });

    await runTurn(service);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a tool that claims a negative cost rather than crediting the budget", async () => {
    const invoke = vi.fn(async () => ({ value: "ok" }));
    const { service } = buildService({
      tools: [descriptor("run_eval_suite", "act", invoke, () => -5)],
      probeBudgetPerTurn: 1,
      runStreaming: streamInvoking("run_eval_suite", 2),
    });

    await runTurn(service);

    expect(invoke).not.toHaveBeenCalled();
  });

  // The contract declares verificationCost as a method, so a contributed descriptor may be
  // class-backed and read `this` to answer. Handing the function over bare would strip that and
  // fail the tool before it runs — a catalog-shaped failure, not a budget one.
  it("keeps a descriptor's own binding when it declares its cost as a method", async () => {
    const invoke = vi.fn(async () => ({ value: "ok" }));
    // Declared with method shorthand and reading its own field, exactly as the interface permits.
    // Nothing binds it here: whether `this` survives is entirely up to how the service calls it.
    const methodBacked = {
      ...descriptor("replay_eval_case", "probe", invoke),
      perCall: 2,
      verificationCost(): number {
        return (this as unknown as { perCall: number }).perCall;
      },
    };
    const { service } = buildService({
      tools: [methodBacked],
      probeBudgetPerTurn: 4,
      runStreaming: streamInvoking("replay_eval_case", 3),
    });

    await runTurn(service);

    // Two calls at 2 units each exhaust a budget of 4; the third is refused.
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("defaults to a budget that admits one full eval suite run", () => {
    expect(COPILOT_PROBE_BUDGET_PER_TURN_DEFAULT).toBeGreaterThanOrEqual(MAX_COPILOT_EVAL_SUITE_CASES);
  });
});
