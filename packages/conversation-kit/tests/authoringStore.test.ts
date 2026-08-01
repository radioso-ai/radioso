import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Directive, DirectiveLifecycle, Routine } from "@radioso/conversation-contract";

import {
  FileConversationKitAuthoringStore,
  TransientConversationKitAuthoringStore,
} from "../src/index.js";

const sampleDirective = (id = "directive_brief"): Directive => ({
  id,
  name: "brief",
  condition: { kind: "always" },
  action: "Answer briefly.",
});

const sampleRoutine = (id = "routine_contact"): Routine => ({
  id,
  rootStepId: "start",
  steps: [
    {
      id: "start",
      kind: "chat",
      action: "Collect the user's email address.",
    },
    {
      id: "done",
      kind: "terminal",
      action: "Confirm the request was captured.",
    },
  ],
  transitions: [{ from: "start", to: "done", condition: "email address collected" }],
});

describe("conversation kit authoring stores", () => {
  it("round-trips agents, directives, and routines in the transient adapter", () => {
    const store = new TransientConversationKitAuthoringStore();

    const agent = store.createAgent({ id: "agent_one", name: "One" });
    expect(store.getAgent(agent.id)).toEqual(agent);
    expect(store.updateAgent(agent.id, { name: "Updated" })?.name).toBe("Updated");
    expect(store.listAgents().map((entry) => entry.id)).toEqual(["agent_one"]);

    const directive = store.createDirective(agent.id, sampleDirective());
    expect(store.getDirective(agent.id, directive.id ?? "")).toEqual(directive);
    expect(store.updateDirective(agent.id, directive.id ?? "", { action: "Use two sentences." })?.action).toBe("Use two sentences.");
    expect(store.listDirectives(agent.id).map((entry) => entry.name)).toEqual(["brief"]);

    const routine = store.createRoutine(sampleRoutine());
    expect(store.getRoutine(routine.id)).toEqual(routine);
    expect(store.updateRoutine(routine.id, { metadata: { version: 2 } })?.metadata).toEqual({ version: 2 });
    expect(store.listRoutines().map((entry) => entry.id)).toEqual(["routine_contact"]);

    expect(store.deleteDirective(agent.id, directive.id ?? "")).toBe(true);
    expect(store.deleteRoutine(routine.id)).toBe(true);
    expect(store.deleteAgent(agent.id)).toBe(true);
    expect(store.listAgents()).toEqual([]);
    expect(store.listDirectives(agent.id)).toEqual([]);
    expect(store.listRoutines()).toEqual([]);
  });

  it("loads file-backed authoring state in a new adapter instance", () => {
    const path = join(mkdtempSync(join(tmpdir(), "conversation-kit-authoring-")), "state.json");
    const first = new FileConversationKitAuthoringStore({ path });

    first.createAgent({ id: "agent_file", name: "File Agent" });
    first.createDirective("agent_file", sampleDirective("directive_file"));
    first.createRoutine(sampleRoutine("routine_file"));

    const second = new FileConversationKitAuthoringStore({ path });

    expect(second.getAgent("agent_file")?.name).toBe("File Agent");
    expect(second.getDirective("agent_file", "directive_file")?.action).toBe("Answer briefly.");
    expect(second.getRoutine("routine_file")?.rootStepId).toBe("start");
  });
});

const authoringStatePath = (): string =>
  join(mkdtempSync(join(tmpdir(), "conversation-kit-authoring-")), "state.json");

const saveAndReloadDirective = (directive: Directive): Directive | null => {
  const path = authoringStatePath();
  const first = new FileConversationKitAuthoringStore({ path });
  first.createAgent({ id: "agent_round_trip" });
  first.createDirective("agent_round_trip", directive);
  return new FileConversationKitAuthoringStore({ path }).getDirective(
    "agent_round_trip",
    directive.id ?? "",
  );
};

const saveAndReloadRoutine = (routine: Routine): Routine | null => {
  const path = authoringStatePath();
  new FileConversationKitAuthoringStore({ path }).createRoutine(routine);
  return new FileConversationKitAuthoringStore({ path }).getRoutine(routine.id);
};

const loadRawSnapshot = (snapshot: unknown): FileConversationKitAuthoringStore => {
  const path = authoringStatePath();
  writeFileSync(path, JSON.stringify(snapshot), "utf8");
  return new FileConversationKitAuthoringStore({ path });
};

describe("file authoring store round-trips the full authoring contract", () => {
  it("preserves directive binding, tags, and metadata", () => {
    const directive: Directive = {
      id: "directive_binding",
      name: "escalate",
      condition: { kind: "contextual", description: "the visitor asks for a human" },
      action: "Hand the conversation to a person.",
      binding: { kind: "skill", skillName: "handoff" },
      tags: ["routine:contact", "step:contact:collect_email"],
      priority: 70,
      lifecycle: { kind: "repeatable" },
      requiredCapabilities: ["handoff"],
      dependsOn: ["directive_greeting"],
      excludes: ["directive_brief"],
      description: "Escalation policy",
      metadata: { authoredBy: "operator", nested: { level: 2 } },
    };

    expect(saveAndReloadDirective(directive)).toEqual(directive);
  });

  it("preserves an explicit null directive binding", () => {
    const directive: Directive = {
      id: "directive_unbound",
      name: "unbound",
      condition: { kind: "always" },
      action: "Stay concise.",
      binding: null,
    };

    expect(saveAndReloadDirective(directive)).toEqual(directive);
  });

  const lifecycles: DirectiveLifecycle[] = [
    { kind: "repeatable" },
    { kind: "once_per_conversation" },
    { kind: "cooldown", turns: 4 },
  ];

  it.each(lifecycles)("preserves the %o directive lifecycle", (lifecycle) => {
    const directive: Directive = {
      id: `directive_${lifecycle.kind}`,
      name: `lifecycle-${lifecycle.kind}`,
      condition: { kind: "always" },
      action: "Introduce yourself.",
      lifecycle,
    };

    expect(saveAndReloadDirective(directive)).toEqual(directive);
  });

  it("preserves a routine containing an await step", () => {
    const routine: Routine = {
      id: "routine_await",
      rootStepId: "ask",
      steps: [
        { id: "ask", kind: "chat", action: "Ask for the order number." },
        { id: "wait", kind: "await", metadata: { reason: "waiting for the customer" } },
        { id: "done", kind: "terminal", action: "Confirm." },
      ],
      transitions: [
        { from: "ask", to: "wait", condition: "the question was asked" },
        { from: "wait", to: "done", condition: "the customer replied" },
      ],
    };

    expect(saveAndReloadRoutine(routine)).toEqual(routine);
  });

  it("preserves skill step bindings, output assignments, mode, and decisions", () => {
    const routine: Routine = {
      id: "routine_skill",
      rootStepId: "lookup",
      steps: [
        {
          id: "lookup",
          kind: "skill",
          skillName: "order_lookup",
          mode: "typed",
          inputBindings: {
            orderId: { kind: "variableRef", ref: "slots.order_id" },
            locale: { kind: "contextVariableRef", contextVariable: "visitor.locale" },
            includeArchived: { kind: "literal", value: true },
            limit: { kind: "literal", value: 10 },
            channel: { kind: "literal", value: "web" },
          },
          outputAssignments: { status: "order_status", total: "order_total" },
        },
        {
          id: "choose",
          kind: "chat",
          action: "Offer the next step.",
          mode: "untyped",
          decision: {
            captureKey: "next_action",
            options: [
              { id: "refund", label: "Refund", description: "Return the money" },
              { id: "replace", label: "Replace", payload: { sku: "abc", tags: ["a", "b"] } },
              { id: "nothing", label: "Nothing" },
            ],
          },
        },
        { id: "emit", kind: "action", actionType: "contact_request" },
        { id: "done", kind: "terminal", action: "Close out." },
      ],
      transitions: [
        { from: "lookup", to: "choose", condition: "the order was found" },
        { from: "choose", to: "emit", condition: "an option was chosen" },
        { from: "emit", to: "done", condition: "always" },
      ],
    };

    expect(saveAndReloadRoutine(routine)).toEqual(routine);
  });

  it("preserves every transition guard kind", () => {
    const routine: Routine = {
      id: "routine_guards",
      rootStepId: "start",
      steps: [
        { id: "start", kind: "chat", action: "Start." },
        { id: "a", kind: "chat", action: "A." },
        { id: "b", kind: "chat", action: "B." },
        { id: "c", kind: "chat", action: "C." },
        { id: "d", kind: "chat", action: "D." },
        { id: "e", kind: "chat", action: "E." },
        { id: "done", kind: "terminal", action: "Done." },
      ],
      transitions: [
        {
          from: "start",
          to: "a",
          condition: "slots are filled",
          guard: { kind: "slot_filled", slots: ["email", "order_id"] },
        },
        {
          from: "start",
          to: "b",
          condition: "the skill completed",
          guard: { kind: "outcome", status: "completed" },
        },
        {
          from: "start",
          to: "c",
          condition: "too many attempts",
          guard: { kind: "counter", limit: 3 },
        },
        {
          from: "start",
          to: "d",
          condition: "the plan is enterprise",
          guard: { kind: "field", ref: "outputs.plan", op: "equals", value: "enterprise" },
        },
        {
          from: "start",
          to: "e",
          condition: "the tier is listed",
          guard: { kind: "field", ref: "outputs.tier", op: "in", values: ["gold", 2, true] },
        },
        {
          from: "a",
          to: "done",
          condition: "the order is stale",
          guard: { kind: "field", ref: "outputs.ordered_at", op: "older_than", value: 30, unit: "days" },
        },
        {
          from: "b",
          to: "done",
          condition: "the flag is set",
          guard: { kind: "field", ref: "slots.consent", op: "is_true" },
        },
        { from: "c", to: "done", condition: "fallback", guard: { kind: "default" } },
        { from: "d", to: "done", condition: "the model decides", guard: { kind: "llm" } },
      ],
    };

    expect(saveAndReloadRoutine(routine)).toEqual(routine);
  });

  it("preserves routine slots, activation, and completion export", () => {
    const routine: Routine = {
      id: "routine_full",
      rootStepId: "start",
      slots: [
        { id: "slot_email", key: "email", type: "email", required: true, description: "Contact email" },
        { id: "slot_qty", key: "quantity", type: "number", required: false, mutable: true },
        { id: "slot_when", key: "when", type: "date", required: false },
      ],
      steps: [
        { id: "start", kind: "chat", action: "Collect details." },
        { id: "done", kind: "terminal", action: "Confirm." },
      ],
      transitions: [{ from: "start", to: "done", condition: "details collected" }],
      completionExport: {
        enabled: true,
        triggerKinds: ["complete", "handoff"],
        destinationRef: "crm_webhook",
      },
      activation: {
        triggerDescription: "the visitor wants to book a demo",
        priority: 80,
        reentryMode: "semantic",
        gateRef: "skill_demo_gate",
      },
      metadata: { source: "authoring" },
    };

    expect(saveAndReloadRoutine(routine)).toEqual(routine);
  });

  it("preserves a routine activation without a gate reference", () => {
    const routine: Routine = {
      id: "routine_activation_min",
      rootStepId: "done",
      steps: [{ id: "done", kind: "terminal", action: "Done." }],
      transitions: [],
      activation: {
        triggerDescription: "the visitor asks about pricing",
        priority: 10,
        reentryMode: "always",
      },
    };

    expect(saveAndReloadRoutine(routine)).toEqual(routine);
  });

  it("preserves a null agent model preference", () => {
    const path = authoringStatePath();
    const first = new FileConversationKitAuthoringStore({ path });
    first.createAgent({ id: "agent_null_model", name: "Null Model", model: null });

    expect(new FileConversationKitAuthoringStore({ path }).getAgent("agent_null_model")).toEqual({
      id: "agent_null_model",
      name: "Null Model",
      model: null,
    });
  });
});

describe("file authoring store still rejects malformed authored state", () => {
  it("drops a directive with a malformed condition", () => {
    const store = loadRawSnapshot({
      agents: [{ id: "agent_bad" }],
      directives: [
        {
          agentId: "agent_bad",
          directive: { id: "d1", name: "bad", action: "Do it.", condition: { kind: "contextual" } },
        },
      ],
      routines: [],
    });

    expect(store.listDirectives("agent_bad")).toEqual([]);
  });

  it("drops a directive with a malformed lifecycle or binding", () => {
    const store = loadRawSnapshot({
      agents: [{ id: "agent_bad" }],
      directives: [
        {
          agentId: "agent_bad",
          directive: {
            id: "d_lifecycle",
            name: "bad lifecycle",
            action: "Do it.",
            condition: { kind: "always" },
            lifecycle: { kind: "cooldown" },
          },
        },
        {
          agentId: "agent_bad",
          directive: {
            id: "d_binding",
            name: "bad binding",
            action: "Do it.",
            condition: { kind: "always" },
            binding: { kind: "routine", routineId: "r1" },
          },
        },
      ],
      routines: [],
    });

    expect(store.listDirectives("agent_bad")).toEqual([]);
  });

  it("drops a routine with an unknown step kind", () => {
    const store = loadRawSnapshot({
      agents: [],
      directives: [],
      routines: [
        {
          id: "routine_bad_step",
          rootStepId: "start",
          steps: [{ id: "start", kind: "nonsense" }],
          transitions: [],
        },
      ],
    });

    expect(store.listRoutines()).toEqual([]);
  });

  it("drops a routine with a transition missing a target", () => {
    const store = loadRawSnapshot({
      agents: [],
      directives: [],
      routines: [
        {
          id: "routine_bad_transition",
          rootStepId: "start",
          steps: [{ id: "start", kind: "chat", action: "Start." }],
          transitions: [{ from: "start", condition: "always" }],
        },
      ],
    });

    expect(store.listRoutines()).toEqual([]);
  });

  it("drops a routine with a malformed guard, input binding, or slot", () => {
    const routines = [
      {
        id: "routine_bad_guard",
        rootStepId: "start",
        steps: [{ id: "start", kind: "chat", action: "Start." }],
        transitions: [{ from: "start", to: "start", condition: "x", guard: { kind: "field", ref: "a" } }],
      },
      {
        id: "routine_bad_binding",
        rootStepId: "start",
        steps: [
          { id: "start", kind: "skill", skillName: "s", inputBindings: { a: { kind: "variableRef" } } },
        ],
        transitions: [],
      },
      {
        id: "routine_bad_slot",
        rootStepId: "start",
        steps: [{ id: "start", kind: "chat", action: "Start." }],
        transitions: [],
        slots: [{ id: "s1", key: "email", type: "postcode", required: true }],
      },
      {
        id: "routine_bad_activation",
        rootStepId: "start",
        steps: [{ id: "start", kind: "chat", action: "Start." }],
        transitions: [],
        activation: { triggerDescription: "x", priority: 1, reentryMode: "sometimes" },
      },
      {
        id: "routine_bad_export",
        rootStepId: "start",
        steps: [{ id: "start", kind: "chat", action: "Start." }],
        transitions: [],
        completionExport: { enabled: true, triggerKinds: ["explode"], destinationRef: "ref" },
      },
      {
        id: "routine_bad_decision",
        rootStepId: "start",
        steps: [
          { id: "start", kind: "chat", action: "Start.", decision: { captureKey: "k", options: [{ id: "a" }] } },
        ],
        transitions: [],
      },
    ];

    const store = loadRawSnapshot({ agents: [], directives: [], routines });

    expect(store.listRoutines()).toEqual([]);
  });
});
