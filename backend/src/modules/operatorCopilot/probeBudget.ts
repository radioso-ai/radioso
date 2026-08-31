import type { AgentTool } from "../../shared/agent-runtime/index.js";

import type { CopilotToolShape } from "./contracts.js";

/**
 * How many `probe` calls one copilot turn may spend.
 *
 * A probe is the shape that costs real provider money without changing configuration — a replayed
 * agent turn, an eval suite run, a website fetch. The turn's step budget already bounds how many
 * tool calls run, but not what they cost: one `run_eval_suite` call replays up to five cases, so a
 * six-step turn can drive thirty full assistant turns off a single reserved copilot answer.
 *
 * Deliberately below the step budget rather than equal to it: a turn that spent every step probing
 * read nothing about the workspace it was probing, so leaving room for reads is the point.
 */
export const COPILOT_PROBE_BUDGET_PER_TURN_DEFAULT = 3;

/**
 * Raised in place of running a probe once the turn's budget is gone.
 *
 * The agent runtime surfaces a tool failure's message into the transcript verbatim, so this text is
 * addressed to the model rather than to an operator: an unexplained failure is one the model will
 * retry, and each retry is another billed call that will fail the same way.
 */
export class CopilotProbeBudgetExhaustedError extends Error {
  constructor(toolName: string, limit: number) {
    super(
      `Verification budget for this turn is spent: ${limit} probe ${limit === 1 ? "call is" : "calls are"} allowed per turn and ${toolName} would exceed it. `
      + "Do not retry this call. Answer with what you already measured, and tell the operator to send a new turn if more verification is needed.",
    );
    this.name = "CopilotProbeBudgetExhaustedError";
  }
}

/** One turn's remaining probe allowance. Created per turn, never shared across turns. */
export interface CopilotProbeBudget {
  spend(toolName: string): void;
}

export const createCopilotProbeBudget = (limit: number): CopilotProbeBudget => {
  let spent = 0;
  return {
    spend(toolName: string) {
      if (spent >= limit) throw new CopilotProbeBudgetExhaustedError(toolName, limit);
      spent += 1;
    },
  };
};

/**
 * Meters a tool by its declared shape rather than by name, so a probe contributed later is metered
 * without also being wired into a list here. Every other shape passes through untouched: reads are
 * free, and `act`/`propose` are bounded by the operator confirming them.
 */
export const meteredCopilotTool = (
  tool: AgentTool,
  shape: CopilotToolShape,
  budget: CopilotProbeBudget,
): AgentTool => {
  if (shape !== "probe") return tool;
  return {
    ...tool,
    invoke: async (input, context) => {
      budget.spend(tool.name);
      return tool.invoke(input, context);
    },
  };
};
