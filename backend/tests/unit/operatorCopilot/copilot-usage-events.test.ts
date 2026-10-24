import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OperatorCopilotService } from "../../../src/modules/operatorCopilot/public.js";
import { InMemoryCopilotRepository } from "../../support/inMemoryCopilotRepository.js";
import {
  AgenticCapabilityRunner,
  DefaultAgentRuntime,
  TextRoutedToolCallingGateway,
} from "../../../src/shared/agent-runtime/index.js";
import { ModelInferencePipelineService } from "../../../src/shared/infra/llm/modelInferencePipeline.js";
import type {
  LlmProviderMetadata,
  ProviderUsage,
  TextGenerationClient,
  TextGenerationRequest,
  TextGenerationResult,
  TextGenerationStreamResult,
} from "../../../src/shared/infra/llm/providerTypes.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../../src/shared/domain/usageEventRecorder.js";

const now = new Date("2026-10-24T00:00:00.000Z");
const workspaceRouteKeyResolver = { resolveWorkspaceKey: async () => "workspace" };
const currentAuthorization = { hasAllPermissions: async () => true };

/**
 * Drives real provider calls through the exact fake: the model answers in the scripted order,
 * and the test asserts on what each call's usage looked like, not on how the gateway framed it.
 */
class ScriptedTextGenerationClient implements TextGenerationClient {
  readonly metadata: LlmProviderMetadata = { capability: "chat", provider: "openai", model: "gpt-ray-test" };
  readonly calls: TextGenerationRequest[] = [];

  constructor(private readonly script: ReadonlyArray<{ text: string; usage: ProviderUsage }>) {}

  async complete(request: TextGenerationRequest): Promise<TextGenerationResult> {
    this.calls.push(request);
    const next = this.script[this.calls.length - 1];
    if (!next) {
      throw new Error(`ScriptedTextGenerationClient: script exhausted at call ${this.calls.length}`);
    }
    return { text: next.text, usage: next.usage };
  }

  stream(): TextGenerationStreamResult {
    throw new Error("ScriptedTextGenerationClient: stream() is not used by the tool-calling gateway");
  }
}

/**
 * Captures exactly what crosses the usage-event recorder port, with no DB involved. Dedupes on
 * `idempotencyKey` the same way the durable recorder's `onConflict(...).doNothing()` does, so a
 * test here catches a key collision the real ledger would also silently drop.
 */
class RecordingUsageEventRecorder implements UsageEventRecorder {
  readonly modelCalls: ModelUsageEvent[] = [];
  private readonly seenIdempotencyKeys = new Set<string>();

  async recordEmbedding(): Promise<void> {}

  async recordModelCall(event: ModelUsageEvent): Promise<void> {
    if (this.seenIdempotencyKeys.has(event.idempotencyKey)) {
      return;
    }
    this.seenIdempotencyKeys.add(event.idempotencyKey);
    this.modelCalls.push(event);
  }
}

const readerTool = (name: string, invoke: (input: unknown) => Promise<unknown>) => ({
  name,
  shape: "read" as const,
  verificationCost: () => 0,
  uiLabel: "Reader",
  description: "reader",
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.string() }),
  requiredPermissions: ["workspace.agents.read"] as const,
  contributingModule: "test",
  dashboardSubject: { type: "workspace" as const },
  createTool: () => ({ name, description: "reader", inputSchema: z.object({}), outputSchema: z.object({ value: z.string() }), invoke }),
});

/** Builds the real production call chain -- capabilityRunner -> runtime -> gateway -> pipeline --
 * with a scripted model client standing in for the provider, so the test exercises the actual
 * seam Ray's calls cross rather than a stand-in for it. */
const buildRealTurnDeps = (script: ReadonlyArray<{ text: string; usage: ProviderUsage }>) => {
  const client = new ScriptedTextGenerationClient(script);
  const usageEventRecorder = new RecordingUsageEventRecorder();
  const pipeline = new ModelInferencePipelineService(client, usageEventRecorder);
  const gateway = new TextRoutedToolCallingGateway(pipeline);
  const runtime = new DefaultAgentRuntime({ gateway });
  const capabilityRunner = new AgenticCapabilityRunner({ runtime });
  return { client, usageEventRecorder, capabilityRunner };
};

describe("Ray turn usage events", () => {
  it("records one usage event per model call, with the right attribution and no content", async () => {
    const toolInvoke = vi.fn(async () => ({ value: "two handoffs are waiting" }));
    const { usageEventRecorder, capabilityRunner } = buildRealTurnDeps([
      {
        text: JSON.stringify({ text: "", tool_calls: [{ id: "call-1", name: "workspace_triage", arguments: {} }] }),
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, quality: "actual" },
      },
      {
        text: JSON.stringify({ text: "Two handoffs are waiting.", tool_calls: [] }),
        usage: { inputTokens: 260, outputTokens: 12, totalTokens: 272, quality: "actual" },
      },
    ]);
    const repository = new InMemoryCopilotRepository();
    const commit = vi.fn(async () => {});
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner,
      usageLimitPolicy: {
        reserveAnswer: vi.fn(async () => ({ commit, release: vi.fn(async () => {}) })),
        reserveDocument: vi.fn(),
        reserveIndexedStorage: vi.fn(),
        reserveMonthlyIndexedContent: vi.fn(),
      },
      auditService: { record: vi.fn(async () => {}) },
      prompt: "system",
      workspaceRouteKeyResolver,
      currentAuthorization,
      tools: [readerTool("workspace_triage", toolInvoke)],
      now: () => now,
    });

    let conversationId: string | undefined;
    for await (const event of service.runTurn({
      surface: "dashboard",
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      conversationId: null,
      message: "What needs attention?",
      pageContext: { view: "activity", agentId: null, conversationId: null, selection: null, entities: [] },
      permissions: new Set(["workspace.agents.read"]),
    })) {
      if (event.event === "conversation") {
        conversationId = (event.data as { conversationId: string }).conversationId;
      }
    }

    expect(conversationId).toBeDefined();
    expect(toolInvoke).toHaveBeenCalledOnce();

    // One event per model call: the planning/tool-call step and the answer step.
    expect(usageEventRecorder.modelCalls).toHaveLength(2);

    for (const recorded of usageEventRecorder.modelCalls) {
      expect(recorded).toMatchObject({
        workspaceId: "workspace-1",
        accountId: "account-1",
        conversationId,
        surface: "operator_copilot",
        operation: "agent_step",
        provider: "openai",
        model: "gpt-ray-test",
        status: "succeeded",
      });
      // The port carries token counts and attribution only -- never a prompt or a completion.
      expect(Object.keys(recorded).sort()).toEqual(
        [
          "accountId",
          "agentId",
          "conversationId",
          "errorCode",
          "idempotencyKey",
          "inputBytes",
          "inputTokens",
          "messageId",
          "model",
          "operation",
          "outputBytes",
          "outputTokens",
          "provider",
          "providerRequestId",
          "reasoningTokens",
          "status",
          "surface",
          "totalTokens",
          "usageQuality",
          "workspaceId",
        ].sort(),
      );
    }

    const [planningStep, answerStep] = usageEventRecorder.modelCalls;
    expect(planningStep).toMatchObject({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    expect(answerStep).toMatchObject({ inputTokens: 260, outputTokens: 12, totalTokens: 272 });

    // Both steps of the same turn carry the same operator-message id, the turn's own identity
    // within the conversation.
    const operatorMessage = repository.messages.find((message) => message.role === "operator");
    expect(operatorMessage).toBeDefined();
    expect(planningStep.messageId).toBe(operatorMessage!.id);
    expect(answerStep.messageId).toBe(operatorMessage!.id);

    // Metering is turn-based (plan-catalog weights a Ray turn, not its model calls), and that must
    // not drift just because the turn now also produces usage events: still exactly one reservation
    // commit for the whole turn, regardless of how many model calls it made.
    expect(commit).toHaveBeenCalledOnce();
  });

  it("keeps the turn-based reservation at exactly one commit across a longer tool loop", async () => {
    const { usageEventRecorder, capabilityRunner } = buildRealTurnDeps([
      {
        text: JSON.stringify({ text: "", tool_calls: [{ id: "call-1", name: "workspace_triage", arguments: {} }] }),
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, quality: "actual" },
      },
      {
        text: JSON.stringify({ text: "", tool_calls: [{ id: "call-2", name: "workspace_triage", arguments: {} }] }),
        usage: { inputTokens: 140, outputTokens: 10, totalTokens: 150, quality: "actual" },
      },
      {
        text: JSON.stringify({ text: "All caught up.", tool_calls: [] }),
        usage: { inputTokens: 180, outputTokens: 8, totalTokens: 188, quality: "actual" },
      },
    ]);
    const repository = new InMemoryCopilotRepository();
    const commit = vi.fn(async () => {});
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner,
      usageLimitPolicy: {
        reserveAnswer: vi.fn(async () => ({ commit, release: vi.fn(async () => {}) })),
        reserveDocument: vi.fn(),
        reserveIndexedStorage: vi.fn(),
        reserveMonthlyIndexedContent: vi.fn(),
      },
      auditService: { record: vi.fn(async () => {}) },
      prompt: "system",
      workspaceRouteKeyResolver,
      currentAuthorization,
      tools: [readerTool("workspace_triage", async () => ({ value: "ok" }))],
      now: () => now,
    });

    for await (const _event of service.runTurn({
      surface: "dashboard",
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      conversationId: null,
      message: "Anything to review?",
      pageContext: { view: "activity", agentId: null, conversationId: null, selection: null, entities: [] },
      permissions: new Set(["workspace.agents.read"]),
    })) {
      // drain the stream
    }

    expect(usageEventRecorder.modelCalls).toHaveLength(3);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("does not let a second turn on the same Ray conversation collide with the first on idempotency key", async () => {
    // Every turn's tool loop restarts its own step count at 0, so a second turn's first call
    // builds the same surface/operation/attemptKey as the first turn's -- only the operator
    // message id tells them apart. Without it, the recorder's idempotency dedup (mirroring the
    // durable ledger's onConflict) would silently drop the second turn's events.
    const { usageEventRecorder, capabilityRunner } = buildRealTurnDeps([
      { text: JSON.stringify({ text: "First answer.", tool_calls: [] }), usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55, quality: "actual" } },
      { text: JSON.stringify({ text: "Second answer.", tool_calls: [] }), usage: { inputTokens: 60, outputTokens: 6, totalTokens: 66, quality: "actual" } },
    ]);
    const repository = new InMemoryCopilotRepository();
    const service = new OperatorCopilotService({
      repository,
      capabilityRunner,
      usageLimitPolicy: {
        reserveAnswer: vi.fn(async () => ({ commit: vi.fn(async () => {}), release: vi.fn(async () => {}) })),
        reserveDocument: vi.fn(),
        reserveIndexedStorage: vi.fn(),
        reserveMonthlyIndexedContent: vi.fn(),
      },
      auditService: { record: vi.fn(async () => {}) },
      prompt: "system",
      workspaceRouteKeyResolver,
      currentAuthorization,
      tools: [],
      now: () => now,
    });

    let conversationId: string | undefined;
    for await (const event of service.runTurn({
      surface: "dashboard",
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      conversationId: null,
      message: "First question?",
      pageContext: { view: "activity", agentId: null, conversationId: null, selection: null, entities: [] },
      permissions: new Set(["workspace.agents.read"]),
    })) {
      if (event.event === "conversation") conversationId = (event.data as { conversationId: string }).conversationId;
    }
    expect(conversationId).toBeDefined();

    for await (const _event of service.runTurn({
      surface: "dashboard",
      workspaceId: "workspace-1",
      accountId: "account-1",
      operatorUserId: "operator-1",
      conversationId: conversationId!,
      message: "Second question?",
      pageContext: { view: "activity", agentId: null, conversationId: null, selection: null, entities: [] },
      permissions: new Set(["workspace.agents.read"]),
    })) {
      // drain the stream
    }

    expect(usageEventRecorder.modelCalls).toHaveLength(2);
    const [first, second] = usageEventRecorder.modelCalls;
    expect(first.conversationId).toBe(conversationId);
    expect(second.conversationId).toBe(conversationId);
    expect(first.messageId).not.toBe(second.messageId);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
});
