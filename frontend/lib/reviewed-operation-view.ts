import { buildCopilotProposalDiff } from '@/components/dashboard/copilot-proposal-changes'
import type { CopilotProposalDetail } from '@/lib/api-copilot'

type ReviewedOperation = NonNullable<CopilotProposalDetail['reviewedOperation']>

interface ReviewedOperationView {
  /** What the change is called, as the dashboard proposal card names it. */
  label: string
  /** Owner-declared consequences of applying it; each is a short fact, not a guess. */
  effects: string[]
  /** Names of the agents the review says the change reaches. */
  agents: string[]
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
    effects: effectLines(operation.effect),
    agents: (operation.affectedAgents ?? []).map((agent) => agent.name),
    rows: buildCopilotProposalDiff(proposal.preview ?? { current: null, proposed: null }),
  }
}
