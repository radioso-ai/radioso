import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  COPILOT_PROBE_BUDGET_PER_TURN_DEFAULT,
  OperatorCopilotService,
  type CopilotSurface,
  type CopilotToolDescriptor,
} from "../../../src/modules/operatorCopilot/public.js";
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
): CopilotToolDescriptor => ({
  name,
  shape,
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
      capabilityRunner: { runStreaming: emptyStream as never },
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
      capabilityRunner: { runStreaming: emptyStream as never },
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
      tools: [descriptor("replay_eval_case", "probe", invoke)],
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
      tools: [descriptor("replay_eval_case", "probe", vi.fn(async () => ({ value: "ok" })))],
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
      tools: [descriptor("replay_eval_case", "probe", invoke)],
      probeBudgetPerTurn: 1,
      runStreaming: streamInvoking("replay_eval_case", 1),
    });

    await runTurn(service);
    await runTurn(service);

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("leaves read, act, and propose tools unmetered", async () => {
    const reads = vi.fn(async () => ({ value: "ok" }));
    const { service } = buildService({
      tools: [descriptor("agent_configuration", "read", reads)],
      probeBudgetPerTurn: 1,
      runStreaming: streamInvoking("agent_configuration", 5),
    });

    await runTurn(service);

    expect(reads).toHaveBeenCalledTimes(5);
  });

  it("defaults the budget below the turn step budget so reads still fit", async () => {
    expect(COPILOT_PROBE_BUDGET_PER_TURN_DEFAULT).toBeGreaterThan(0);
    expect(COPILOT_PROBE_BUDGET_PER_TURN_DEFAULT).toBeLessThan(6);
  });
});
