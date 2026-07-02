// Conversation source channels produced by operator-driven test traffic from the
// dashboard: the in-dashboard test chat and the workbench/eval replay. These are
// excluded by default from operator-triage read surfaces (Activity history, Quality
// turns, Needs-Attention approvals) so an operator's own testing does not pollute the
// signals they use to triage real end-user conversations.
export const OPERATOR_TEST_SOURCE_CHANNELS = ["authenticated_chat", "workbench_replay"] as const;

// Which conversation sources a read surface should return. `end_user` (the default)
// excludes operator-test traffic; `operator_test` returns only it; `all` returns both.
export type ConversationSourceScope = "end_user" | "operator_test" | "all";

export const isOperatorTestSourceChannel = (sourceChannel: string | null | undefined): boolean =>
  sourceChannel != null && (OPERATOR_TEST_SOURCE_CHANNELS as readonly string[]).includes(sourceChannel);
