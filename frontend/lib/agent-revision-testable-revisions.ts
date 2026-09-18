import type { AgentRevisionState, AgentRevisionSummary } from './api-agent-revisions'

/**
 * A saved draft with no changes holds exactly the published scoped authoring, so
 * a candidate built from it would test nothing the live revision does not. An
 * agent that has never published still needs its candidate: it is the only
 * revision there is to test.
 */
export const candidateIsTestable = (state: AgentRevisionState): boolean =>
  state.status !== 'draft_clean' || state.publishedRevision === null

/**
 * The revision list the Test Chat offers, with the candidate (when one exists)
 * first and selected by default; otherwise the live published revision leads.
 */
export const assembleTestableRevisions = ({
  state,
  published,
  candidate,
}: {
  state: AgentRevisionState
  published: AgentRevisionSummary[]
  candidate: AgentRevisionSummary | null
}): {
  revisions: AgentRevisionSummary[]
  candidateId: string | null
  defaultSelectedId: string | null
} => {
  const revisions = candidate
    ? [candidate, ...published.filter((revision) => revision.id !== candidate.id)]
    : published
  const publishedId =
    published.find((revision) => revision.id === state.publishedRevision?.id)?.id ??
    published[0]?.id ??
    null
  return {
    revisions,
    candidateId: candidate?.id ?? null,
    defaultSelectedId: candidate?.id ?? publishedId,
  }
}

/**
 * A comparison needs two distinct immutable revisions; the same id on both
 * sides is a selection the operator can fix, so the client withholds the start
 * instead of surfacing the API's rejection.
 */
export const compareSelectionRepeatsRevision = (
  mode: 'single' | 'compare',
  selected: readonly string[],
): boolean => mode === 'compare' && selected.length === 2 && selected[0] === selected[1]
