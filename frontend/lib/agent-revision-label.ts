import type { AgentRevisionSummary } from './api-agent-revisions'

/** How a revision is named wherever an operator sees it: published as vN, a candidate by its creation time. */
export const revisionDisplayLabel = (revision: AgentRevisionSummary): string => {
  if (revision.kind === "published" && revision.versionNumber !== null)
    return `v${revision.versionNumber}`;
  if (revision.kind === "candidate")
    return `Draft · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(revision.createdAt))}`;
  return "Legacy revision";
};
