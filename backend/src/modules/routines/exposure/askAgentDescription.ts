import type { AgentToolDescriptor } from "./agentToolDescriptor.js";

/**
 * How many exposed tools the description names. A calling model chooses between tools by reading
 * this text, so the list is a pointer, not an inventory — the full catalog is `tools/list`, which
 * the same client already has. The bound keeps one agent's tool count from deciding how large
 * every caller's prompt is.
 */
const MAX_NAMED_TOOLS = 12;

interface AskAgentDescriptionSource {
  readonly agent: { readonly name: string; readonly description: string | null };
  readonly tools: ReadonlyArray<Pick<AgentToolDescriptor, "toolName">>;
}

/**
 * The `ask_agent` description a calling agent reads, composed from the agent's name, the
 * operator-authored public description, and the names of its exposed tools (spec 1290, FR-052).
 *
 * Assembled from configuration by a pure function, deliberately: it is read at catalog time by
 * every caller, it must be byte-stable so a client that caches a tool list sees no churn, and an
 * operator who changes their description has to be able to predict what the change does. A model
 * writing it at request time would satisfy none of those.
 */
export const composeAskAgentDescription = (source: AskAgentDescriptionSource): string => {
  const named = source.tools.slice(0, MAX_NAMED_TOOLS).map((tool) => tool.toolName);
  const covers = source.agent.description?.trim();
  const sentences = [
    `Hold a conversation with ${source.agent.name}.`,
    covers ? `It covers ${covers}.` : null,
    "Runs the agent's full behavior — persona, directives, and multi-step routines — and continues the same conversation across calls (stateful).",
    named.length > 0
      ? `Prefer the typed tools for the tasks they name (${named.join(", ")}); use this for anything else, or when you do not know which tool applies.`
      : "Use this for an interactive agent experience, not just a one-off fact lookup.",
  ];
  return sentences.filter((sentence): sentence is string => sentence !== null).join(" ");
};
