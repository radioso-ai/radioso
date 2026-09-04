/**
 * The currency `AgentBudgets.maxToolResultTokens` is denominated in.
 *
 * A tool result is charged against the turn's budget by estimating its serialized size, so a caller
 * that bounds its own payloads must size them in the same currency the runtime will charge them in.
 * Sizing a payload against an independently chosen character budget is how a single read ends up
 * costing more than the whole turn was allowed to spend.
 */
const CHARS_PER_TOKEN = 4;

/** What the runtime charges a tool result that does not declare its own `estimatedResultTokens`. */
export const estimateAgentResultTokens = (output: unknown): number => {
  try {
    const serialized = JSON.stringify(output) ?? "";
    return Math.max(1, Math.ceil(serialized.length / CHARS_PER_TOKEN));
  } catch {
    return 1;
  }
};

/**
 * The inverse: the largest serialized payload that still costs at most `tokens`.
 *
 * Callers bounding a tool payload use this to state the bound in tokens — the unit the budget is
 * actually kept in — and let this module convert.
 */
export const agentResultCharBudget = (tokens: number): number =>
  Math.max(0, Math.floor(tokens)) * CHARS_PER_TOKEN;
