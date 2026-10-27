/**
 * Read-only view of the words an agent greets with, for a channel that says them outside a
 * conversation, such as a voice call's first message. It is the greeting the web chat shows a
 * visitor in the same locale, without its chips: the published revision's exact words, else the
 * generated greeting cached for the agent and locale, generated and cached when none is. Nothing
 * is started, delivered or audited; a generated greeting reserves its usage as a `greeting` on
 * `surface`, the way the web chat's does.
 */
export interface AgentGreetingReader {
  /**
   * The greeting as written for reading (it may hold markdown), or null when the agent greets no
   * one in the locale: its greeting is off, no exact variant serves the locale, or the model wrote
   * nothing. `locale` is the caller's language tag; null reads the agent's default. Rejects when
   * the greeting could not be read or generated.
   */
  readGreeting(input: { workspaceId: string; agentId: string; locale: string | null; surface: string }): Promise<string | null>;
}
