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
