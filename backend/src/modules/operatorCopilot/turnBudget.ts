import {
  AGENT_BUDGET_DEFAULTS,
  agentResultCharBudget,
  type AgentBudgets,
} from "../../shared/agent-runtime/index.js";

/**
 * What one Ray turn may spend on the tool loop behind an operator's question.
 *
 * Sized for diagnosis rather than lookup, but only where diagnosis actually costs more.
 *
 * `maxToolResultTokens` and `maxWallTimeMs` are raised because the diagnostic reads are large and
 * slow: one real turn trace measures around 7,800 tokens, so the shared 12,000-token default spent
 * two thirds of a turn on a single read and left nothing to reason with. `maxSteps` is deliberately
 * *not* raised. It bounds serial depth rather than tool calls — several tools may be called within
 * one step — and no diagnostic chain in the copilot eval dataset is more than two calls deep, so
 * the default already carries margin over what the work needs.
 *
 * The asymmetry is intentional, and follows from how each ceiling fails. Running out of steps still
 * buys a closing answer, so a tight step budget costs at worst a less complete reply. Running out of
 * wall time hands the operator a blank card, and every step re-submits the transcript, so steps are
 * the expensive dimension and the one worth keeping tight.
 *
 * Every value stays under the runtime's `AGENT_BUDGET_CEILINGS` so its clamp remains a real guard
 * rather than a formality this surface has already spent.
 */
export const COPILOT_TURN_BUDGET: AgentBudgets = {
  maxSteps: AGENT_BUDGET_DEFAULTS.maxSteps,
  maxToolResultTokens: 24_000,
  maxWallTimeMs: 90_000,
};

/**
 * A single reader's slice of {@link COPILOT_TURN_BUDGET}, in serialized characters.
 *
 * Readers bound their payloads as a share of the turn rather than to a figure of their own, so the
 * bound moves with the budget it is spent against. A share must leave room for the rest of the
 * turn: a read that can consume the whole allowance ends the turn on the step that produced it,
 * and the operator gets an exhausted card instead of the answer they asked for.
 */
export const copilotPayloadCharBudget = (shareOfTurn: number): number =>
  agentResultCharBudget(COPILOT_TURN_BUDGET.maxToolResultTokens * shareOfTurn);
