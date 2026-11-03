import { AppError } from "../../../shared/domain/errors.js";

// Runtime-revision failure vocabulary. Every case here is either an operator-
// recoverable data state (an unbindable legacy conversation) or a deployment
// wiring gap (a resolver/repository capability that isn't configured) — never
// a caller bug, so none of these should surface as an unhandled 500. Codes
// stay stable and machine-readable; the errorHandler classifies AppError by
// `statusCode` and reports it without the unhandled-crash path.
export const conversationRevisionBindingUnavailable = (): AppError =>
  new AppError(
    503,
    "conversation_revision_binding_unavailable",
    "This deployment's conversation store cannot bind an agent revision to a conversation. Revision-aware chat is not fully configured here; contact support.",
  );

export const agentRevisionCandidateRequiresTrustedRunner = (): AppError =>
  new AppError(
    403,
    "agent_revision_candidate_requires_trusted_runner",
    "A candidate agent revision may only be supplied by a trusted safe-test runner.",
  );

export const agentRevisionRuntimeNotConfigured = (): AppError =>
  new AppError(
    503,
    "agent_revision_runtime_not_configured",
    "Agent revision resolution is not configured for this deployment.",
  );

export const conversationRevisionUnavailable = (): AppError =>
  new AppError(
    409,
    "conversation_revision_unavailable",
    "This conversation predates revision tracking and could not be bound to a rollout baseline automatically. An operator needs to review it before it can continue.",
  );
