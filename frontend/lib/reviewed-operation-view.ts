import { buildCopilotProposalDiff } from '@/lib/copilot-proposal-diff'
import type { CopilotProposalDetail } from '@/lib/api-copilot'

type ReviewedOperation = NonNullable<CopilotProposalDetail['reviewedOperation']>

interface ReviewedOperationView {
  /** What the change is called, as the dashboard proposal card names it. */
  label: string
  /** The producer's one-line statement of intent, when it gave one. */
  summary: string | null
  /** Owner-declared consequences of applying it; each is a short fact, not a guess. */
  effects: string[]
  /** Whether the change alters who can reach an agent. */
  reach: boolean
  /** Names of the agents the review says the change reaches, and whether more are affected than listed. */
  agents: { names: string[]; hasMore: boolean }
  /** The same current/proposed rows a dashboard proposal shows. */
  rows: ReturnType<typeof buildCopilotProposalDiff>
}

const effectLines = (effect: ReviewedOperation['effect']): string[] => [
  effect.exposure === 'live' ? 'Goes live when applied' : 'Saved as a draft',
  ...(effect.reversibility === 'irreversible' ? ["Can't be undone"] : []),
  ...(effect.metered ? ['Uses quota'] : []),
]

export const buildReviewedOperationView = (proposal: CopilotProposalDetail): ReviewedOperationView => {
  const operation = proposal.reviewedOperation!
  return {
    label: proposal.targetLabel ?? '',
    summary: operation.summary ?? null,
    effects: effectLines(operation.effect),
    reach: operation.reach ?? false,
    // A backend that has not deployed these fields yet omits them; the page reads that as none.
    agents: { names: (operation.affectedAgents?.agents ?? []).map((agent) => agent.name), hasMore: operation.affectedAgents?.truncated ?? false },
    rows: buildCopilotProposalDiff(proposal.preview ?? { current: null, proposed: null }),
  }
}
