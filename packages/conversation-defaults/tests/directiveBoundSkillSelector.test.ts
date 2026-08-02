import { describe, expect, it } from "vitest";

import type { DirectiveMatch, SkillDefinition, TurnContext } from "@radioso/conversation-contract";
import {
  createDirectiveBoundSkillSelector,
  type DirectiveBindingSkillState,
} from "../src/index.js";

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "Where is my order?" },
  history: [],
  stagedContext: [],
  steering: [],
};

const skill = (name: string): SkillDefinition => ({ name });

type MatchOverrides = Partial<Omit<DirectiveMatch, "directive">> & {
  name: string;
  skillName?: string;
  directive?: Partial<DirectiveMatch["directive"]>;
};

const match = ({ name, skillName, directive, ...rest }: MatchOverrides): DirectiveMatch => ({
  directive: {
    name,
    condition: { kind: "always" },
    action: "Use the bound skill.",
    ...(skillName ? { binding: { kind: "skill" as const, skillName } } : {}),
    ...directive,
  },
  selectionMode: "deterministic",
  selectionReason: "always",
  ...rest,
});

describe("createDirectiveBoundSkillSelector", () => {
  it("selects exactly the skill an authored directive binds, with a directive reason", async () => {
    const selector = createDirectiveBoundSkillSelector();

    const decision = await selector.select({
      turn,
      skills: [skill("retrieval.answer"), skill("order_lookup")],
      directives: [match({ name: "order-status", skillName: "order_lookup" })],
    });

    expect(decision.selected).toEqual([
      expect.objectContaining({ skillName: "order_lookup", reason: "directive:order-status" }),
    ]);
    expect(decision.reason).toBe("directive:order-status");
  });

  it("lists every candidate skill in considered with a selected flag and a reason", async () => {
    const selector = createDirectiveBoundSkillSelector();

    const decision = await selector.select({
      turn,
      skills: [skill("retrieval.answer"), skill("order_lookup"), skill("refund")],
      directives: [
        match({ name: "order-status", skillName: "order_lookup", directive: { priority: 90 } }),
        match({ name: "refunds", skillName: "refund", directive: { priority: 10 } }),
      ],
    });

    const considered = decision.considered ?? [];
    expect(considered.map((entry) => entry.skillName).sort()).toEqual([
      "order_lookup",
      "refund",
      "retrieval.answer",
    ]);
    expect(considered.filter((entry) => entry.selected).map((entry) => entry.skillName)).toEqual([
      "order_lookup",
    ]);
    expect(considered.find((entry) => entry.skillName === "order_lookup")?.reason).toBe(
      "directive:order-status",
    );
    expect(considered.find((entry) => entry.skillName === "refund")?.reason).toBe("lost_conflict");
    expect(considered.find((entry) => entry.skillName === "retrieval.answer")?.reason).toBeDefined();
  });

  it("selects nothing and surfaces the skip reason when a binding names an unregistered skill", async () => {
    const selector = createDirectiveBoundSkillSelector();

    const decision = await selector.select({
      turn,
      skills: [skill("retrieval.answer")],
      directives: [match({ name: "order-status", skillName: "order_lookup" })],
    });

    expect(decision.selected).toEqual([]);
    expect(decision.reason).toBe("directive_bindings_skipped");
    const skipped = (decision.considered ?? []).find((entry) => entry.skillName === "order_lookup");
    expect(skipped).toMatchObject({ selected: false, reason: "skill_not_registered" });
  });

  it("distinguishes no bound directives from bindings that were all skipped", async () => {
    const selector = createDirectiveBoundSkillSelector();

    const decision = await selector.select({
      turn,
      skills: [skill("retrieval.answer")],
      directives: [match({ name: "tone" })],
    });

    expect(decision.selected).toEqual([]);
    expect(decision.reason).toBe("no_directive_binding");
    expect(decision.reason).not.toBe("directive_bindings_skipped");
  });

  it("reads host-supplied skill states through the optional supplier", async () => {
    const states = new Map<string, DirectiveBindingSkillState>([
      ["order_lookup", { enabled: false, turnCapable: true, stagingCapable: false }],
    ]);
    const selector = createDirectiveBoundSkillSelector({ agentSkillStates: () => states });

    const decision = await selector.select({
      turn,
      skills: [skill("retrieval.answer"), skill("order_lookup")],
      directives: [match({ name: "order-status", skillName: "order_lookup" })],
    });

    expect(decision.selected).toEqual([]);
    expect(decision.reason).toBe("directive_bindings_skipped");
    expect((decision.considered ?? []).find((entry) => entry.skillName === "order_lookup")).toMatchObject({
      selected: false,
      reason: "skill_not_enabled",
    });
  });
});
