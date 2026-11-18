import type { AgentRevisionSummary, RevisionEvalRevisionSummary } from './api-agent-revisions'

/** How a revision is named wherever an operator sees it: published as vN, a candidate by its creation time. */
export const revisionDisplayLabel = (revision: AgentRevisionSummary): string => {
  if (revision.kind === "published" && revision.versionNumber !== null)
    return `v${revision.versionNumber}`;
  if (revision.kind === "candidate")
    return `Draft · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(revision.createdAt))}`;
  return "Legacy revision";
};

/** The eval API carries only a raw label for a draft, so a draft takes its time from the full revision when known. */
export const evalRevisionLabel = (evalRevision: RevisionEvalRevisionSummary, revision: AgentRevisionSummary | undefined): string => {
  if (evalRevision.versionNumber !== null) return `v${evalRevision.versionNumber}`
  return revision ? revisionDisplayLabel(revision) : 'Draft'
}
