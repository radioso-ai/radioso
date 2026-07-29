import type { QualityTriageState } from '@/lib/api'

/**
 * Triage states still in the active backlog. The signal chips and the inbox count
 * only these so resolved/dismissed turns drain out of the totals.
 *
 * Signal classification itself lives in the backend quality module and is
 * addressed by `QualitySignalId` — one definition shared by the health rates and
 * the chip counts, rather than reconstructed here from the skill catalog.
 */
export const ACTIVE_TRIAGE_STATES: readonly QualityTriageState[] = ['open', 'acknowledged']
