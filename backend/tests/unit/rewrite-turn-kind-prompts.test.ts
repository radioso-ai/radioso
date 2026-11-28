import { describe, expect, it } from "vitest";

import { buildTurnInterpretationPrompt } from "../../src/modules/chat/services/conversationTurnInterpreter.js";
import { buildTurnPlanningPrompt } from "../../src/modules/chat/services/turnPlanService.js";
import { buildTurnPlanResponseFormat } from "../../src/modules/chat/services/turnPlanWireFormat.js";
import { REWRITE_TURN_KIND } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { buildQueryRewritePrompt } from "../../src/modules/retrieval/services/queryRewritePromptBuilder.js";

const today = "2026-11-28 (Saturday)";
const query = "I mean in the routine";

/**
 * The three prompts that ask a model for a rewrite's turn kind: the fused turn planner, the
 * staged turn interpretation, and retrieval's own rewrite. Retrieval anchors the subject of a
 * referential turn (`queryRewriteService.ts`), so the model has to be told what each kind means;
 * a kind it only sees as an enum value is a guess, and a follow-up that narrows the previous
 * question was guessed to be a fresh subject (#1873).
 */
const rewritePrompts: Array<[surface: string, prompt: string]> = [
  [
    "turn planning",
    buildTurnPlanningPrompt({ query, history: [], routineCandidates: [], directiveCandidates: [], today }).systemPrompt,
  ],
  ["turn interpretation", buildTurnInterpretationPrompt({ context: "", query, today })],
  ["query rewrite", buildQueryRewritePrompt({ context: "", query, today })],
];

const turnKindRule = (prompt: string): string | undefined =>
  prompt.split("\n").find((line) => line.startsWith("turnKind:"));

/** The turn kinds the prompt's JSON blueprint offers, in the order it lists them. */
const blueprintTurnKinds = (prompt: string): string[] | undefined =>
  /"turnKind":"([a-z_|]+)"/.exec(prompt)?.[1].split("|");

describe("rewrite prompt turn kinds", () => {
  it.each(rewritePrompts)("the %s prompt defines every turn kind a rewrite can return", (_surface, prompt) => {
    const rule = turnKindRule(prompt);

    expect(rule).toBeDefined();
    for (const kind of Object.values(REWRITE_TURN_KIND)) {
      expect(rule).toContain(kind);
    }
  });

  it.each(rewritePrompts)("the %s prompt's blueprint offers exactly the turn kinds retrieval reads", (_surface, prompt) => {
    expect(blueprintTurnKinds(prompt)?.sort()).toEqual(Object.values(REWRITE_TURN_KIND).sort());
  });

  it("the planner's response schema offers exactly the turn kinds retrieval reads", () => {
    const schema = buildTurnPlanResponseFormat({ routineIds: [], directiveNames: [] }).schema as {
      properties: { rewrite: { properties: { turnKind: { enum: string[] } } } };
    };

    expect([...schema.properties.rewrite.properties.turnKind.enum].sort()).toEqual(Object.values(REWRITE_TURN_KIND).sort());
  });
});
