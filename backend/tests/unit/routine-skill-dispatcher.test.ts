import fs from "node:fs/promises";
import path from "node:path";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RoutineSkillExecutorDispatcher,
  StaticRoutineSkillResolver,
  type RoutineSkillResolver,
} from "../../src/modules/routines/skillDispatcher.js";
import { externalSkillRoutineDefinition } from "../../src/modules/externalSkills/routineSkillResolver.js";
import {
  SkillExecutorRegistry,
  type SkillDefinition,
  type SkillExecutorPort,
  type SkillInvocation,
  type SkillOutcome,
} from "../../src/modules/skills/public.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";
import { capabilityNames } from "../../src/shared/domain/capabilityPolicy.js";
import { initializeTracing, shutdownTracing } from "../../src/shared/observability/tracing/index.js";
import type { Routine, RoutineState, StagedContext, TurnContext } from "@radioso/conversation-contract";
import { DefaultRoutineRunner } from "@radioso/conversation-engine";
import { ChatTurnSupersededError } from "../../src/modules/chat/services/conversationTurnRegistry.js";
import { CUSTOMER_EMAIL_SKILLS_ADAPTER } from "../../src/modules/customerEmail/public.js";
import { EXTERNAL_SKILLS_ADAPTER } from "../../src/modules/externalSkills/public.js";
import { NOTIFY_SKILLS_ADAPTER } from "../../src/modules/notify/public.js";
import { SLACK_SKILLS_ADAPTER } from "../../src/modules/slackSkills/public.js";
import { WEBHOOK_SKILLS_ADAPTER } from "../../src/modules/webhookSkills/public.js";
import { RETRIEVAL_ANSWER_ADAPTER, RetrieveRoutineSkillResolver } from "../../src/modules/retrieval/public.js";
import { retrievalContextSkillDefinition } from "../../src/modules/skills/public.js";

const TEST_EXECUTION = { kind: "internal" as const, adapter: "test-adapter" };

const skillNamed = (
  name: string,
  execution: SkillDefinition["execution"] = TEST_EXECUTION,
  requiredCapabilities: string[] = [],
  requiresDurableConversation?: boolean,
): SkillDefinition => ({ name, execution, requiredCapabilities, requiresDurableConversation }) as unknown as SkillDefinition;

const routineState = (variables: Record<string, unknown>): RoutineState =>
  ({
    sessionId: "session-1",
    routineId: "routine-1",
    path: ["collect", "invoke_skill"],
    variables,
    status: "active",
  }) as unknown as RoutineState;

const turn = { agent: { id: "agent-1" }, stagedContext: [], sessionId: "session-1" } as unknown as TurnContext;

const turnWithStagedContext = (stagedContext: StagedContext[]): TurnContext =>
  ({ ...turn, stagedContext });

const settledExecutor = (
  outcome: SkillOutcome,
  capture?: (invocation: SkillInvocation) => void,
): SkillExecutorPort => ({
  async dispatch(invocation) {
    capture?.(invocation);
    return { disposition: "settled", outcome };
  },
});

const registryWith = (executor: SkillExecutorPort): SkillExecutorRegistry => {
  const registry = new SkillExecutorRegistry();
  registry.register({ ...TEST_EXECUTION, executor });
  return registry;
};

class RecordingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    this.spans.push(...spans);
    callback({ code: 0 });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const enableTracing = (): RecordingExporter => {
  const exporter = new RecordingExporter();
  initializeTracing({
    enabled: true,
    environment: "test",
    otlpEndpoint: "http://localhost:4318/v1/traces",
    runtimeRole: "api",
    serviceName: "radioso-api",
    spanExporter: exporter,
  });
  return exporter;
};

afterEach(async () => {
  await shutdownTracing();
});

describe("RoutineSkillExecutorDispatcher", () => {
  it.each([
    ["webhook", WEBHOOK_SKILLS_ADAPTER],
    ["customer email", CUSTOMER_EMAIL_SKILLS_ADAPTER],
    ["Slack", SLACK_SKILLS_ADAPTER],
    ["notify", NOTIFY_SKILLS_ADAPTER],
    ["external MCP", EXTERNAL_SKILLS_ADAPTER],
  ])("suppresses the %s executor in probe mode before live dispatch", async (_label, adapter) => {
    const dispatch = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed" } as unknown as SkillOutcome,
    }));
    const registry = new SkillExecutorRegistry();
    registry.register({ kind: "internal", adapter, executor: { dispatch } });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([
        skillNamed("opaque_probe_skill", { kind: "internal", adapter, enqueue: false }),
      ]),
      registry,
      { skillEffects: "suppressed" },
    );

    const result = await dispatcher.dispatch({
      skillName: "opaque_probe_skill",
      state: routineState({ privateValue: "must-not-leave-process" }),
      turn,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "failed",
      outputs: { skill: "opaque_probe_skill", reason: "suppressed_for_safe_test" },
      metadata: { failureReason: "suppressed_for_safe_test" },
      actsOutsideConversation: false,
    });
  });

  it.each([
    ["webhook", WEBHOOK_SKILLS_ADAPTER],
    ["external MCP", EXTERNAL_SKILLS_ADAPTER],
  ])("dispatches the %s executor when skillEffects is explicitly allowed (Test Chat's real-effects toggle)", async (_label, adapter) => {
    const dispatch = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed" } as unknown as SkillOutcome,
    }));
    const registry = new SkillExecutorRegistry();
    registry.register({ kind: "internal", adapter, executor: { dispatch } });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([
        skillNamed("opaque_probe_skill", { kind: "internal", adapter, enqueue: false }),
      ]),
      registry,
      { skillEffects: "allowed" },
    );

    const result = await dispatcher.dispatch({
      skillName: "opaque_probe_skill",
      state: routineState({}),
      turn,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
  });

  it("refuses a skill that requires a durable conversation when the turn's conversation is ephemeral, even with skills allowed", async () => {
    const dispatch = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed" } as unknown as SkillOutcome,
    }));
    const registry = new SkillExecutorRegistry();
    registry.register({ kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER, executor: { dispatch } });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([
        skillNamed("contact_human", { kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER, enqueue: false }, [], true),
      ]),
      registry,
      { skillEffects: "allowed", conversationDurability: "ephemeral" },
    );

    const result = await dispatcher.dispatch({ skillName: "contact_human", state: routineState({}), turn });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "failed",
      outputs: { skill: "contact_human", reason: "requires_durable_conversation" },
      metadata: { failureReason: "requires_durable_conversation" },
      actsOutsideConversation: false,
    });
  });

  it("reports suppression, not durability, when both apply to an ephemeral suppressed turn", async () => {
    const dispatch = vi.fn();
    const registry = new SkillExecutorRegistry();
    registry.register({ kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER, executor: { dispatch } });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([
        skillNamed("contact_human", { kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER, enqueue: false }, [], true),
      ]),
      registry,
      { skillEffects: "suppressed", conversationDurability: "ephemeral" },
    );

    const result = await dispatcher.dispatch({ skillName: "contact_human", state: routineState({}), turn });

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.outputs?.reason).toBe("suppressed_for_safe_test");
  });

  it("dispatches a durable-conversation skill normally on a durable conversation and a skill without the requirement on an ephemeral one", async () => {
    const dispatch = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed" } as unknown as SkillOutcome,
    }));
    const registry = new SkillExecutorRegistry();
    registry.register({ kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER, executor: { dispatch } });
    registry.register({ kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER, executor: { dispatch } });
    const resolver = new StaticRoutineSkillResolver([
      skillNamed("contact_human", { kind: "internal", adapter: NOTIFY_SKILLS_ADAPTER, enqueue: false }, [], true),
      skillNamed("remote_lookup", { kind: "internal", adapter: EXTERNAL_SKILLS_ADAPTER, enqueue: false }),
    ]);

    const durable = new RoutineSkillExecutorDispatcher(resolver, registry, { conversationDurability: "durable" });
    const ephemeral = new RoutineSkillExecutorDispatcher(resolver, registry, { skillEffects: "allowed", conversationDurability: "ephemeral" });

    await expect(durable.dispatch({ skillName: "contact_human", state: routineState({}), turn })).resolves.toMatchObject({ status: "completed" });
    await expect(ephemeral.dispatch({ skillName: "remote_lookup", state: routineState({}), turn })).resolves.toMatchObject({ status: "completed" });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("defaults to allowed dispatch when no skillEffects option is given", async () => {
    const dispatch = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed" } as unknown as SkillOutcome,
    }));
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith({ dispatch }),
    );

    const result = await dispatcher.dispatch({ skillName: "book_meeting", state: routineState({}), turn });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
  });

  it("keeps the activated routine and step observable when a probe suppresses its skill", async () => {
    const exporter = enableTracing();
    const metricsRegistry = new MetricsRegistry();
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("opaque_probe_skill")]),
      registryWith(settledExecutor({ status: "completed" } as unknown as SkillOutcome)),
      { skillEffects: "suppressed", metricsRegistry },
    );

    await dispatcher.dispatch({ skillName: "opaque_probe_skill", state: routineState({}), turn });

    const span = exporter.spans.find((candidate) => candidate.name === "routine.skill.dispatch");
    expect(span?.attributes).toMatchObject({
      "routine.id": "routine-1",
      "routine.step_id": "invoke_skill",
      "outcome.status": "failed",
      "outcome.reason": "suppressed_for_safe_test",
    });
    expect(metricsRegistry.renderPrometheus()).toContain('reason="suppressed_for_safe_test"');
  });

  it("resolves a skill by name, dispatches through the registry, and projects the outcome", async () => {
    const outcome = {
      status: "completed",
      outputs: { bookingId: "bk_1" },
      answer: "Booked.",
    } as unknown as SkillOutcome;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(settledExecutor(outcome)),
    );

    const result = await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({}),
      turn,
    });

    expect(result).toEqual({
      status: "completed",
      outputs: { bookingId: "bk_1" },
      answer: "Booked.",
      actsOutsideConversation: true,
    });
  });

  it("lets static built-ins win before a delegate resolver handles dynamic external names", async () => {
    const staticSkill = skillNamed("retrieval.answer", TEST_EXECUTION, [capabilityNames.retrieval.answer]);
    const resolver = new StaticRoutineSkillResolver([staticSkill], {
      resolve: (name) => skillNamed(name, { kind: "internal", adapter: "external-adapter" }),
    });

    expect(resolver.resolve("retrieval.answer")).toBe(staticSkill);
    expect(resolver.resolve("crm_lookup")?.execution).toEqual({ kind: "internal", adapter: "external-adapter" });
  });

  it("carries a custom (fine-grained) status verbatim so the runner can branch on it", async () => {
    // The generic adapter may surface a service-shaped status (design seam: the
    // closed SkillOutcome enum → the open RoutineSkillResult union). It must
    // survive the projection unchanged, or condition-gated branches can't match.
    const outcome = {
      status: "slot_conflict",
      outputs: { requested: "2026-06-20T10:00" },
    } as unknown as SkillOutcome;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(settledExecutor(outcome)),
    );

    const result = await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({}),
      turn,
    });

    expect(result.status).toBe("slot_conflict");
    expect(result.outputs).toEqual({ requested: "2026-06-20T10:00" });
  });

  it("projects a settled executor failure's error code onto host-private metadata.failureReason", async () => {
    const outcome = {
      status: "failed",
      error: { code: "mcp_timeout", message: "External tool call timed out", retryable: true },
    } as unknown as SkillOutcome;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("crm_converse")]),
      registryWith(settledExecutor(outcome)),
    );

    const result = await dispatcher.dispatch({
      skillName: "crm_converse",
      state: routineState({}),
      turn,
    });

    expect(result.status).toBe("failed");
    expect(result.metadata).toEqual({ failureReason: "mcp_timeout" });
  });

  it("falls back to outputs.reason for a settled executor failure that reports no error code", async () => {
    const outcome = {
      status: "failed",
      outputs: { reason: "context_missing" },
    } as unknown as SkillOutcome;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("notify_customer")]),
      registryWith(settledExecutor(outcome)),
    );

    const result = await dispatcher.dispatch({
      skillName: "notify_customer",
      state: routineState({}),
      turn,
    });

    expect(result.status).toBe("failed");
    expect(result.metadata).toEqual({ failureReason: "context_missing" });
  });

  it("merges a settled executor failure's error code into any existing outcome metadata", async () => {
    const outcome = {
      status: "failed",
      error: { code: "mcp_call_failed", message: "External tool call failed" },
      metadata: { __retrievalResult: { traceId: "retrieval-trace" } },
    } as unknown as SkillOutcome;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("crm_converse")]),
      registryWith(settledExecutor(outcome)),
    );

    const result = await dispatcher.dispatch({
      skillName: "crm_converse",
      state: routineState({}),
      turn,
    });

    expect(result.metadata).toEqual({
      __retrievalResult: { traceId: "retrieval-trace" },
      failureReason: "mcp_call_failed",
    });
  });

  it("preserves non-model skill metadata for host-side routine renderers", async () => {
    const outcome = {
      status: "context_ready",
      outputs: { has_context: true },
      metadata: { __retrievalResult: { traceId: "retrieval-trace" } },
    } as unknown as SkillOutcome;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("retrieval.context")]),
      registryWith(settledExecutor(outcome)),
    );

    const result = await dispatcher.dispatch({
      skillName: "retrieval.context",
      state: routineState({}),
      turn,
    });

    expect(result).toEqual({
      status: "context_ready",
      outputs: { has_context: true },
      metadata: { __retrievalResult: { traceId: "retrieval-trace" } },
      actsOutsideConversation: true,
    });
  });

  it("passes the routine's captured slots as the invocation's collected params", async () => {
    let captured: SkillInvocation | undefined;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(
        settledExecutor({ status: "completed" } as unknown as SkillOutcome, (invocation) => {
          captured = invocation;
        }),
      ),
    );

    await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({ email: "a@b.com", duration: 30 }),
      turn,
    });

    expect(captured?.skill.name).toBe("book_meeting");
    expect(captured?.collected).toEqual({ email: "a@b.com", duration: 30 });
    expect(captured?.collectedOrigins).toEqual({ email: "slot", duration: "slot" });
  });

  it("passes workspace and account context to skill executors", async () => {
    let captured: SkillInvocation | undefined;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("post_to_slack")]),
      registryWith(
        settledExecutor({ status: "completed" } as unknown as SkillOutcome, (invocation) => {
          captured = invocation;
        }),
      ),
      { workspaceId: "workspace-1", accountId: "account-1" },
    );

    await dispatcher.dispatch({
      skillName: "post_to_slack",
      state: routineState({}),
      turn,
    });

    expect(captured?.context).toMatchObject({
      workspaceId: "workspace-1",
      accountId: "account-1",
      agentId: "agent-1",
    });
  });

  it("resolves typed input bindings into executor collected params when provided", async () => {
    let captured: SkillInvocation | undefined;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(
        settledExecutor({ status: "completed" } as unknown as SkillOutcome, (invocation) => {
          captured = invocation;
        }),
      ),
    );

    await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({ customerEmail: "a@b.com", ignored: "not forwarded" }),
      inputBindings: {
        email: { kind: "variableRef", ref: "customerEmail" },
        duration: { kind: "literal", value: 30 },
        optional: { kind: "variableRef", ref: "missing" },
      },
      turn,
    });

    expect(captured?.collected).toEqual({ email: "a@b.com", duration: 30 });
    expect(captured?.collectedOrigins).toEqual({ email: "slot", duration: "literal" });
  });

  it("resolves context-variable input bindings from the turn staged context", async () => {
    let captured: SkillInvocation | undefined;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("checkout_lookup")]),
      registryWith(
        settledExecutor({ status: "completed" } as unknown as SkillOutcome, (invocation) => {
          captured = invocation;
        }),
      ),
    );

    await dispatcher.dispatch({
      skillName: "checkout_lookup",
      state: routineState({}),
      inputBindings: {
        page: { kind: "contextVariableRef", contextVariable: "page_context" },
        cart: { kind: "contextVariableRef", contextVariable: "cart" },
        plan: { kind: "contextVariableRef", contextVariable: "plan" },
      },
      turn: turnWithStagedContext([
        {
          kind: "context_variable",
          id: "page_context",
          data: { kind: "page_context", pageUrl: "https://example.test/cart" },
          metadata: { variableName: "page_context" },
        },
        {
          kind: "context_variable",
          id: "cart",
          data: { kind: "variable", name: "cart", value: { items: 2 } },
          metadata: { variableName: "cart" },
        },
        {
          kind: "context_variable",
          id: "plan",
          data: "enterprise",
          metadata: {},
        },
      ]),
    });

    expect(captured?.collected).toEqual({
      page: { kind: "page_context", pageUrl: "https://example.test/cart" },
      cart: { items: 2 },
      plan: "enterprise",
    });
    expect(captured?.collectedOrigins).toEqual({ page: "context", cart: "context", plan: "context" });
  });

  it("threads the turn and agent id into the executor context", async () => {
    let captured: SkillInvocation | undefined;
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(
        settledExecutor({ status: "completed" } as unknown as SkillOutcome, (invocation) => {
          captured = invocation;
        }),
      ),
    );

    await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({}),
      turn,
    });

    expect(captured?.context).toMatchObject({
      turn,
      agentId: "agent-1",
      routineId: "routine-1",
      stepId: "invoke_skill",
    });
  });

  it("degrades to failed (not a throw) when the referenced skill is not resolvable", async () => {
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([]),
      registryWith(settledExecutor({ status: "completed" } as unknown as SkillOutcome)),
    );

    // Degrades rather than throwing: throwing here would 500 the turn pre-persistence
    // and permanently wedge the resumable routine. The runner advances off `failed`.
    const result = await dispatcher.dispatch({ skillName: "missing", state: routineState({}), turn });
    expect(result).toEqual({ status: "failed", outputs: { skill: "missing", reason: "unknown_skill" }, metadata: { failureReason: "unknown_skill" }, actsOutsideConversation: false });
  });

  it("degrades to failed when the resolved skill has no execution descriptor", async () => {
    const resolver: RoutineSkillResolver = {
      resolve: () => ({ name: "book_meeting" }) as unknown as SkillDefinition,
    };
    const dispatcher = new RoutineSkillExecutorDispatcher(
      resolver,
      registryWith(settledExecutor({ status: "completed" } as unknown as SkillOutcome)),
    );

    const result = await dispatcher.dispatch({ skillName: "book_meeting", state: routineState({}), turn });
    expect(result).toEqual({ status: "failed", outputs: { skill: "book_meeting", reason: "no_execution" }, metadata: { failureReason: "no_execution" }, actsOutsideConversation: false });
  });

  it("degrades to failed when no executor is registered for the skill's execution", async () => {
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([
        skillNamed("book_meeting", { kind: "internal", adapter: "unregistered" }),
      ]),
      new SkillExecutorRegistry(),
    );

    const result = await dispatcher.dispatch({ skillName: "book_meeting", state: routineState({}), turn });
    expect(result).toEqual({ status: "failed", outputs: { skill: "book_meeting", reason: "no_executor" }, metadata: { failureReason: "no_executor" }, actsOutsideConversation: false });
  });

  it("degrades to failed when the executor defers — a routine step must branch on a settled result", async () => {
    const deferringExecutor: SkillExecutorPort = {
      async dispatch() {
        return { disposition: "deferred", ticket: { ticketId: "t_1" } };
      },
    };
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(deferringExecutor),
    );

    const result = await dispatcher.dispatch({ skillName: "book_meeting", state: routineState({}), turn });
    expect(result).toEqual({ status: "failed", outputs: { skill: "book_meeting", reason: "deferred" }, metadata: { failureReason: "deferred" }, actsOutsideConversation: true });
  });

  it("requires external skill invoke capability for routine external skills", () => {
    expect(externalSkillRoutineDefinition("crm_lookup").requiredCapabilities).toEqual([
      capabilityNames.externalSkills.invoke,
    ]);
  });

  it("degrades and does not invoke the executor when the capability gate denies a required capability", async () => {
    const dispatch = vi.fn();
    const gate = vi.fn(async () => ({ allowed: false, reason: "plan_disabled" }));
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("crm_lookup", TEST_EXECUTION, [capabilityNames.externalSkills.invoke])]),
      registryWith({ dispatch }),
      { capabilityGate: gate },
    );

    await expect(dispatcher.dispatch({ skillName: "crm_lookup", state: routineState({}), turn })).resolves.toEqual({
      status: "failed",
      outputs: { skill: "crm_lookup", reason: "capability_denied" },
      metadata: { failureReason: "capability_denied" },
      actsOutsideConversation: false,
    });
    expect(gate).toHaveBeenCalledWith(capabilityNames.externalSkills.invoke);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("invokes the executor when the capability gate allows a required capability", async () => {
    const dispatch = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed", outputs: { ok: true } } as unknown as SkillOutcome,
    }));
    const gate = vi.fn(async () => ({ allowed: true }));
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("crm_lookup", TEST_EXECUTION, [capabilityNames.externalSkills.invoke])]),
      registryWith({ dispatch }),
      { capabilityGate: gate },
    );

    const result = await dispatcher.dispatch({ skillName: "crm_lookup", state: routineState({}), turn });

    expect(result).toEqual({ status: "completed", outputs: { ok: true }, answer: undefined, actsOutsideConversation: true });
    expect(gate).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not invoke the selected executor when cancellation lands during routine activation", async () => {
    const dispatch = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed" } as unknown as SkillOutcome,
    }));
    let cancelled = false;
    const throwIfCancelled = vi.fn(() => {
      if (cancelled) {
        throw new ChatTurnSupersededError("session-1", "routing");
      }
    });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("crm_lookup", TEST_EXECUTION, [capabilityNames.externalSkills.invoke])]),
      registryWith({ dispatch }),
      {
        capabilityGate: async () => {
          cancelled = true;
          return { allowed: true };
        },
        throwIfCancelled,
      },
    );

    await expect(
      dispatcher.dispatch({ skillName: "crm_lookup", state: routineState({}), turn }),
    ).rejects.toBeInstanceOf(ChatTurnSupersededError);
    expect(throwIfCancelled).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not call the capability gate for a skill with no required capabilities", async () => {
    const dispatch = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed" } as unknown as SkillOutcome,
    }));
    const gate = vi.fn(async () => ({ allowed: false }));
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith({ dispatch }),
      { capabilityGate: gate },
    );

    await expect(dispatcher.dispatch({ skillName: "book_meeting", state: routineState({}), turn })).resolves.toMatchObject({
      status: "completed",
    });
    expect(gate).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("degrades instead of throwing when the capability gate rejects", async () => {
    const dispatch = vi.fn();
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("crm_lookup", TEST_EXECUTION, ["unknown.capability"])]),
      registryWith({ dispatch }),
      {
        capabilityGate: async () => {
          throw new Error("unknown capability");
        },
      },
    );

    await expect(dispatcher.dispatch({ skillName: "crm_lookup", state: routineState({}), turn })).resolves.toEqual({
      status: "failed",
      outputs: { skill: "crm_lookup", reason: "capability_denied" },
      metadata: { failureReason: "capability_denied" },
      actsOutsideConversation: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("records a privacy-safe span and metric for a successful dispatch", async () => {
    const exporter = enableTracing();
    const metricsRegistry = new MetricsRegistry();
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(settledExecutor({
        status: "completed",
        outputs: { privateOutput: "do-not-trace" },
        answer: "do-not-trace",
      } as unknown as SkillOutcome)),
      { metricsRegistry },
    );

    await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({ secret: "private slot" }),
      turn,
    });

    const span = exporter.spans.find((candidate) => candidate.name === "routine.skill.dispatch");
    expect(span?.attributes).toMatchObject({
      "routine.id": "routine-1",
      "routine.step_id": "invoke_skill",
      "skill.name": "book_meeting",
      "outcome.status": "completed",
    });
    const serializedAttributes = JSON.stringify(span?.attributes);
    expect(serializedAttributes).not.toContain("private slot");
    expect(serializedAttributes).not.toContain("privateOutput");
    expect(serializedAttributes).not.toContain("do-not-trace");
    expect(serializedAttributes).not.toContain("variables");
    expect(serializedAttributes).not.toContain("outputs");
    expect(serializedAttributes).not.toContain("answer");

    const metrics = metricsRegistry.renderPrometheus();
    expect(metrics).toContain("radioso_routine_skill_dispatch_total");
    expect(metrics).toContain('outcome="settled"');
    expect(metrics).toContain('reason="none"');
    expect(metrics).not.toContain("routine-1");
    expect(metrics).not.toContain("book_meeting");
  });

  it("does not use custom routine result statuses as metric labels", async () => {
    const metricsRegistry = new MetricsRegistry();
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("book_meeting")]),
      registryWith(settledExecutor({
        status: "slot_conflict",
        outputs: { requested: "2026-06-20T10:00" },
      } as unknown as SkillOutcome)),
      { metricsRegistry },
    );

    await dispatcher.dispatch({
      skillName: "book_meeting",
      state: routineState({}),
      turn,
    });

    const metrics = metricsRegistry.renderPrometheus();
    expect(metrics).toContain('outcome="settled"');
    expect(metrics).toContain('reason="none"');
    expect(metrics).not.toContain("slot_conflict");
  });

  it("records a privacy-safe span and metric for an unavailable dispatch", async () => {
    const exporter = enableTracing();
    const metricsRegistry = new MetricsRegistry();
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([]),
      registryWith(settledExecutor({ status: "completed" } as unknown as SkillOutcome)),
      { metricsRegistry },
    );

    await dispatcher.dispatch({ skillName: "missing", state: routineState({ token: "private token" }), turn });

    const span = exporter.spans.find((candidate) => candidate.name === "routine.skill.dispatch");
    expect(span?.attributes).toMatchObject({
      "routine.id": "routine-1",
      "routine.step_id": "invoke_skill",
      "skill.name": "missing",
      "outcome.status": "failed",
      "outcome.reason": "unknown_skill",
    });
    const serializedAttributes = JSON.stringify(span?.attributes);
    expect(serializedAttributes).not.toContain("private token");
    expect(serializedAttributes).not.toContain("variables");
    expect(serializedAttributes).not.toContain("outputs");
    expect(serializedAttributes).not.toContain("answer");

    const metrics = metricsRegistry.renderPrometheus();
    expect(metrics).toContain('outcome="failed"');
    expect(metrics).toContain('reason="unknown_skill"');
    expect(metrics).not.toContain("routine-1");
    expect(metrics).not.toContain("missing");
  });

  it("keeps routine dispatcher wiring out of conversation engine and contract packages", async () => {
    const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
    const packageRoots = [
      path.join(repositoryRoot, "packages/conversation-engine"),
      path.join(repositoryRoot, "packages/conversation-contract"),
    ];

    const files = await Promise.all(packageRoots.map((packageRoot) => listTypeScriptFiles(packageRoot)));
    const contents = await Promise.all(files.flat().map(async (filePath) => fs.readFile(filePath, "utf8")));

    expect(contents.join("\n")).not.toContain("RoutineSkillExecutorDispatcher");
    expect(contents.join("\n")).not.toContain("externalSkillRoutineDefinition");
    expect(contents.join("\n")).not.toContain("backend/src/modules/routines");
  });
});

describe("RoutineSkillExecutorDispatcher reports whether a skill acted outside the conversation", () => {
  const settledOn = (adapter: string) => {
    const dispatch = vi.fn(async () => ({
      disposition: "settled" as const,
      outcome: { status: "completed" } as unknown as SkillOutcome,
    }));
    const registry = new SkillExecutorRegistry();
    registry.register({ kind: "internal", adapter, executor: { dispatch } });
    return { dispatch, registry };
  };

  it("reports the built-in retrieval.context skill as staying inside the conversation", async () => {
    const { dispatch, registry } = settledOn(RETRIEVAL_ANSWER_ADAPTER);
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([retrievalContextSkillDefinition]),
      registry,
    );

    const result = await dispatcher.dispatch({ skillName: "retrieval.context", state: routineState({}), turn });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.actsOutsideConversation).toBe(false);
  });

  it("reports an agent's named retrieve skill as staying inside the conversation", async () => {
    const { registry } = settledOn(RETRIEVAL_ANSWER_ADAPTER);
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new RetrieveRoutineSkillResolver([{ skillName: "policy_lookup", enabled: true, invocationMode: "routine_named" }]),
      registry,
    );

    const result = await dispatcher.dispatch({ skillName: "policy_lookup", state: routineState({}), turn });

    expect(result.actsOutsideConversation).toBe(false);
  });

  it.each([
    ["webhook", WEBHOOK_SKILLS_ADAPTER],
    ["customer email", CUSTOMER_EMAIL_SKILLS_ADAPTER],
    ["Slack", SLACK_SKILLS_ADAPTER],
    ["notify", NOTIFY_SKILLS_ADAPTER],
    ["external MCP", EXTERNAL_SKILLS_ADAPTER],
  ])("reports a %s skill that ran as acting outside the conversation", async (_label, adapter) => {
    const { dispatch, registry } = settledOn(adapter);
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("send_it", { kind: "internal", adapter, enqueue: false })]),
      registry,
    );

    const result = await dispatcher.dispatch({ skillName: "send_it", state: routineState({}), turn });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.actsOutsideConversation).toBe(true);
  });

  it("reports a skill whose executor threw as acting outside the conversation, since it may have acted first", async () => {
    const registry = new SkillExecutorRegistry();
    registry.register({
      kind: "internal",
      adapter: WEBHOOK_SKILLS_ADAPTER,
      executor: { dispatch: vi.fn(async () => { throw new Error("socket hang up"); }) },
    });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([skillNamed("send_it", { kind: "internal", adapter: WEBHOOK_SKILLS_ADAPTER, enqueue: false })]),
      registry,
    );

    const result = await dispatcher.dispatch({ skillName: "send_it", state: routineState({}), turn });

    expect(result).toMatchObject({ status: "failed", outputs: { reason: "executor_error" }, actsOutsideConversation: true });
  });

  describe("in a safe test", () => {
    // A routine that looks something up, then answers from it: `lookup` (a skill step) → `answer`.
    const lookupThenAnswer = (skillName: string): Routine => ({
      id: "lookup_then_answer",
      rootStepId: "lookup",
      steps: [
        { id: "lookup", kind: "skill", skillName },
        { id: "answer", kind: "chat", action: "Answer from what the lookup found." },
      ],
      transitions: [{ from: "lookup", to: "answer", condition: "always" }],
    });
    const claimSafeTestTurn = async (skill: SkillDefinition, executor: SkillExecutorPort) => {
      const registry = new SkillExecutorRegistry();
      registry.register({ ...(skill.execution as { kind: "internal"; adapter: string }), executor });
      const rendered: Array<{ stepId: string; staged: StagedContext[] }> = [];
      const runner = new DefaultRoutineRunner(
        [lookupThenAnswer(skill.name)],
        { select: async () => ({ nextStepId: "answer" }) },
        {
          render: async ({ step, turn: renderedTurn }) => {
            rendered.push({ stepId: step.id, staged: renderedTurn.stagedContext });
            return { answer: `reply:${step.id}` };
          },
        },
        new RoutineSkillExecutorDispatcher(new StaticRoutineSkillResolver([skill]), registry, { skillEffects: "suppressed" }),
      );
      const claim = await runner.claim({
        turn: { ...turn, inputEvent: { id: "input-1", kind: "message", content: "When are you open?" }, history: [], steering: [] },
        state: { sessionId: "session-1", routineId: "lookup_then_answer", path: [], variables: {}, status: "active" },
        activationTurn: true,
      });
      if (claim.kind !== "claimed") throw new Error("expected the routine to claim the turn");
      await claim.reply.render();
      return { claim, rendered };
    };

    it("runs a retrieval.context step, which stays inside the conversation, and grounds the next step on it", async () => {
      const retrievalResult = { traceId: "retrieval-trace", contexts: [{ title: "Opening hours", content: "Nine to five." }] };
      const lookup = vi.fn(async () => ({
        disposition: "settled" as const,
        outcome: {
          status: "context_ready",
          outputs: { has_context: true },
          metadata: { __retrievalResult: retrievalResult },
        } as unknown as SkillOutcome,
      }));

      const { claim, rendered } = await claimSafeTestTurn(retrievalContextSkillDefinition, { dispatch: lookup });

      expect(lookup).toHaveBeenCalledOnce();
      expect(claim.effects.skillsWithExternalEffects).toBeUndefined();
      expect(claim.effects.trace?.steps[0]).toMatchObject({ stepId: "lookup", event: "skill_dispatched", skillStatus: "context_ready" });
      expect(rendered).toEqual([{
        stepId: "answer",
        staged: [expect.objectContaining({
          source: "retrieval.context",
          metadata: expect.objectContaining({ skillMetadata: { __retrievalResult: retrievalResult } }),
        })],
      }]);
    });

    it("still suppresses a webhook step, which then reports no effect outside the conversation", async () => {
      const callWebhook = vi.fn();
      const webhook = skillNamed("crm_webhook", { kind: "internal", adapter: WEBHOOK_SKILLS_ADAPTER, enqueue: false });

      const { claim } = await claimSafeTestTurn(webhook, { dispatch: callWebhook });

      expect(callWebhook).not.toHaveBeenCalled();
      expect(claim.effects.trace?.steps[0]).toMatchObject({ stepId: "lookup", skillStatus: "failed", skillReason: "suppressed_for_safe_test" });
      expect(claim.effects.skillsWithExternalEffects).toBeUndefined();
    });
  });

  it("reports a skill that never ran as staying inside the conversation", async () => {
    const { dispatch, registry } = settledOn(WEBHOOK_SKILLS_ADAPTER);
    const resolver = new StaticRoutineSkillResolver([
      skillNamed("send_it", { kind: "internal", adapter: WEBHOOK_SKILLS_ADAPTER, enqueue: false }),
    ]);

    const unknown = await new RoutineSkillExecutorDispatcher(resolver, registry)
      .dispatch({ skillName: "missing", state: routineState({}), turn });
    const suppressed = await new RoutineSkillExecutorDispatcher(resolver, registry, { skillEffects: "suppressed" })
      .dispatch({ skillName: "send_it", state: routineState({}), turn });

    expect(dispatch).not.toHaveBeenCalled();
    expect(unknown).toMatchObject({ outputs: { reason: "unknown_skill" }, actsOutsideConversation: false });
    expect(suppressed).toMatchObject({ outputs: { reason: "suppressed_for_safe_test" }, actsOutsideConversation: false });
  });
});

const listTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(entryPath);
    }
    if (entry.isFile() && /\.(ts|tsx|d\.ts)$/u.test(entry.name)) {
      return [entryPath];
    }
    return [];
  }));
  return nested.flat();
};
