import type { AgentTool } from "../../shared/agent-runtime/index.js";

import type { CopilotToolDescriptor } from "./contracts.js";

/**
 * How much model-backed work one copilot turn may command, counted in replayed turns.
 *
 * The turn's step budget bounds how many tool calls run, not what they cost: a single
 * `run_eval_suite` call replays several cases, so a six-step turn could otherwise drive dozens of
 * full assistant turns off one reserved copilot answer.
 *
 * At least one whole eval suite run fits, because a suite run is the unit an operator actually
 * asks for — a budget that could not admit one would make Ray refuse the request it was given
 * rather than pace it.
 */
export const COPILOT_PROBE_BUDGET_PER_TURN_DEFAULT = 6;

/**
 * Raised in place of running a tool once the turn's budget cannot cover it.
 *
 * The agent runtime surfaces a tool failure's message into the transcript verbatim, so this text is
 * addressed to the model rather than to an operator: an unexplained failure is one the model will
 * retry, and each retry is another billed call that will fail the same way.
 */
export class CopilotProbeBudgetExhaustedError extends Error {
  constructor(toolName: string, cost: number, remaining: number) {
    super(
      `Verification budget for this turn cannot cover ${toolName}: it costs ${cost} and ${remaining} ${remaining === 1 ? "run is" : "runs are"} left. `
      + "Do not retry this call. Answer with what you already measured, and tell the operator to send a new turn if more verification is needed.",
    );
    this.name = "CopilotProbeBudgetExhaustedError";
  }
}

/** One turn's remaining allowance. Created per turn, never shared across turns. */
export interface CopilotProbeBudget {
  spend(toolName: string, cost: number): void;
}

export const createCopilotProbeBudget = (limit: number): CopilotProbeBudget => {
  let remaining = limit;
  return {
    spend(toolName: string, cost: number) {
      // Refused whole rather than partially: a five-case suite run allowed through on a remaining
      // budget of one would spend five, which is the overrun the budget exists to prevent.
      if (cost > remaining) throw new CopilotProbeBudgetExhaustedError(toolName, cost, remaining);
      remaining -= cost;
    },
  };
};

/**
 * Meters a tool by the cost its descriptor declares.
 *
 * Deliberately not by `shape`. Shape answers "what does this change, and what confirmation does it
 * need" — a different question from "what does this spend", and conflating them is what let
 * `run_eval_suite` through: it is an `act` because it moves a case's stored verdict, and it is also
 * the most expensive call in the catalog. A tool states its own cost, and a call that costs
 * nothing is invoked untouched.
 */
export const meteredCopilotTool = (
  tool: AgentTool,
  verificationCost: CopilotToolDescriptor["verificationCost"],
  budget: CopilotProbeBudget,
): AgentTool => ({
  ...tool,
  invoke: async (input, context) => {
    // Asked per call rather than once, because a tool's cost can depend on its arguments.
    const cost = verificationCost(input);
    if (cost > 0) budget.spend(tool.name, cost);
    return tool.invoke(input, context);
  },
});
