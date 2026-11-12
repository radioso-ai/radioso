import type { AgentRevisionSummary, ExecutionState, RevisionEvalRun } from './api-agent-revisions'

/** The words Test Chat shows for a revision, a test's state, an eval outcome, its evidence, and a failed side. */

export const revisionDisplayLabel = (revision: AgentRevisionSummary): string => {
  if (revision.kind === "published" && revision.versionNumber !== null)
    return `v${revision.versionNumber}`;
  if (revision.kind === "candidate")
    return `Draft · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(revision.createdAt))}`;
  return "Legacy revision";
};

export const executionStateLabel: Record<ExecutionState, string> = {
  missing: "Not run",
  running: "Running",
  partial: "Partial",
  failed: "Failed",
  completed: "Completed",
};

export const outcomeLabel: Record<
  RevisionEvalRun["sides"][number]["cases"][number]["outcome"],
  string
> = {
  pass: "Passed",
  fail: "Failed",
  partial: "Partial",
  unavailable: "Unavailable",
};

export const evidenceLabel: Record<
  RevisionEvalRun["sides"][number]["evidenceState"],
  string
> = {
  current: "Current",
  configuration_changed: "Configuration changed since run",
  environment_changed: "Environment changed since run",
  comparability_unknown: "Comparability unknown (live dependencies)",
};

export const failureLabel = (code: string) =>
  ({
    provider_unavailable: "The provider was unavailable.",
    stream_transport_failed: "The response stream was interrupted.",
    stream_ended_before_terminal_event: "The response ended before completion.",
    retry_transport_failed: "The retry response stream was interrupted.",
  })[code] ?? "This test side failed.";
