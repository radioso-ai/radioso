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
import type { RoutineState, StagedContext, TurnContext } from "@radioso/conversation-contract";

const TEST_EXECUTION = { kind: "internal" as const, adapter: "test-adapter" };

const skillNamed = (
  name: string,
  execution: SkillDefinition["execution"] = TEST_EXECUTION,
  requiredCapabilities: string[] = [],
): SkillDefinition => ({ name, execution, requiredCapabilities }) as unknown as SkillDefinition;

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
  ({ ...turn, stagedContext }) as TurnContext;

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
    expect(result).toEqual({ status: "failed", outputs: { skill: "missing", reason: "unknown_skill" } });
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
    expect(result).toEqual({ status: "failed", outputs: { skill: "book_meeting", reason: "no_execution" } });
  });

  it("degrades to failed when no executor is registered for the skill's execution", async () => {
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new StaticRoutineSkillResolver([
        skillNamed("book_meeting", { kind: "internal", adapter: "unregistered" }),
      ]),
      new SkillExecutorRegistry(),
    );

    const result = await dispatcher.dispatch({ skillName: "book_meeting", state: routineState({}), turn });
    expect(result).toEqual({ status: "failed", outputs: { skill: "book_meeting", reason: "no_executor" } });
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
    expect(result).toEqual({ status: "failed", outputs: { skill: "book_meeting", reason: "deferred" } });
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

    expect(result).toEqual({ status: "completed", outputs: { ok: true }, answer: undefined });
    expect(gate).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
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
