import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Directive, Routine } from "@radioso/conversation-contract";

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
