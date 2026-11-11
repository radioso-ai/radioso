// Conversation source channels produced by operator-driven test traffic from the
// dashboard: the in-dashboard test chat, workbench/eval replay, and Ray turn probes. These are
// excluded by default from operator-triage read surfaces (Activity history, Quality
// turns, Needs-Attention approvals) so an operator's own testing does not pollute the
// signals they use to triage real end-user conversations.
export const OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL = "operator_copilot_probe" as const;

// Interactive test sessions that operators can reopen in the agent workbench.
// Synthetic automation such as Ray probes is deliberately excluded even though
// it remains operator-test traffic for customer-facing population filters.
export const WORKBENCH_TEST_SOURCE_CHANNELS = [
  "authenticated_chat",
  "workbench_replay",
] as const;

export const OPERATOR_TEST_SOURCE_CHANNELS = [
  ...WORKBENCH_TEST_SOURCE_CHANNELS,
  OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
] as const;

// Which conversation sources a read surface should return. `end_user` (the default)
// excludes all operator-test traffic; `operator_test` returns interactive workbench
// test sessions; `all` returns both plus synthetic operator traffic.
export type ConversationSourceScope = "end_user" | "operator_test" | "all";

export const isOperatorTestSourceChannel = (sourceChannel: string | null | undefined): boolean =>
  sourceChannel != null && (OPERATOR_TEST_SOURCE_CHANNELS as readonly string[]).includes(sourceChannel);

// A spoken session through a voice vendor. The vendor's runtime makes the HTTP call, but the caller
// is the person on the call or in the browser, so voice is a human channel.
export const VOICE_SOURCE_CHANNEL = "voice" as const;

// Channels on which the caller is another piece of software rather than a person: the MCP converse
// door, the REST agent channel, and the A2A JSON-RPC door. Slack, the embed, the anonymous link,
// voice, and the dashboard all carry a person, and operator-test traffic is a person driving a test.
export const AGENT_SOURCE_CHANNELS = ["mcp", "agent_api", "a2a"] as const;

export type AgentSourceChannel = typeof AGENT_SOURCE_CHANNELS[number];

// Whether the other side of a conversation is a person or a calling agent. Derived from the source
// channel rather than stored independently, so a conversation cannot claim a kind its channel
// contradicts.
export const CALLER_KINDS = ["human", "agent"] as const;

export type CallerKind = typeof CALLER_KINDS[number];

/** Narrows a stored `caller_kind` to the vocabulary the domain owns; the column carries no CHECK. */
export const asCallerKind = (value: string | null | undefined): CallerKind | null =>
  (CALLER_KINDS as readonly string[]).includes(value ?? "") ? value as CallerKind : null;

/**
 * `source_channel` is an unconstrained `TEXT` column written from string literals at each call site,
 * so this mapping is total and needs a default. It is `"human"`: caller kind exists to scope
 * agent-only behaviour, and silently treating a person as an agent is the worse of the two failures.
 */
export const callerKindForSourceChannel = (sourceChannel: string | null | undefined): CallerKind =>
  sourceChannel != null && (AGENT_SOURCE_CHANNELS as readonly string[]).includes(sourceChannel)
    ? "agent"
    : "human";

// Channels that carry a person but show no buttons, so a consent's choices go out as text under its
// wording and the visitor answers in writing: email, WhatsApp and Slack, and the operator surfaces
// that show a reply's text alone (Test Chat and eval replays, Ray's probe).
const TEXT_ONLY_SOURCE_CHANNELS: readonly string[] = ["email", "whatsapp", "slack", "workbench_replay", OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL];

/**
 * How a channel shows a routine's consent (#1544): `buttons` (the wording, with the two choices as
 * buttons), `text` (the wording, then the two choices as lines of text), or `not_asked`. Voice asks
 * none because its transcript is weak proof and no audio is kept, and a calling agent asks none
 * because it cannot give a person's consent; there the routine takes the consent's decline path.
 * Like {@link callerKindForSourceChannel}, total over the untyped column: a channel nobody has
 * classified gets buttons, which a person can always answer in writing instead.
 */
export const consentPresentationFor = (sourceChannel: string | null | undefined): "buttons" | "text" | "not_asked" => {
  if (sourceChannel === VOICE_SOURCE_CHANNEL || callerKindForSourceChannel(sourceChannel) === "agent") {
    return "not_asked";
  }
  return sourceChannel != null && TEXT_ONLY_SOURCE_CHANNELS.includes(sourceChannel) ? "text" : "buttons";
};
