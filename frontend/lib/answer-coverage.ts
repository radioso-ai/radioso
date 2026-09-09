import type { DiagnosticPresentation } from '@/lib/activity-diagnostics'

export type AnswerCoverageAvailability = 'assessed' | 'not_recorded' | 'failed' | 'invalid'
export type AnswerCoverageValue = 'answered' | 'partial' | 'unanswered' | 'unclear'
export type AnswerCoverageReason =
  | 'sufficient_evidence'
  | 'insufficient_evidence'
  | 'conflicting_evidence'
  | 'ambiguous_request'
  | 'intentional_scope_boundary'

export interface AnswerCoverageReaction {
  assessmentRequestId: string
  target: 'directive' | 'routine'
  targetId?: string
  decision: 'matched' | 'applied' | 'offered' | 'activated' | 'skipped' | 'suppressed'
  reasonCode: string
  routineExecutionId?: string
  targetMessageId: string
}

export interface AnswerCoverageAssessment {
  availability: AnswerCoverageAvailability
  coverage?: AnswerCoverageValue
  reason?: AnswerCoverageReason
  unresolvedRequest?: string
  contextualizedRequest?: string
  originatingTurnId: string
  originatingRequestId: string
  schemaVersion?: number
  assessedAt?: string
}

const answerCoverageReasonsByCoverage = {
  answered: ['sufficient_evidence'],
  partial: ['insufficient_evidence', 'conflicting_evidence', 'intentional_scope_boundary'],
  unanswered: ['insufficient_evidence', 'conflicting_evidence', 'intentional_scope_boundary'],
  unclear: ['ambiguous_request'],
} as const satisfies Record<AnswerCoverageValue, readonly AnswerCoverageReason[]>

export const compatibleAnswerCoverageReasons = (
  coverage: readonly AnswerCoverageValue[],
): AnswerCoverageReason[] => Array.from(new Set(
  coverage.flatMap((value) => answerCoverageReasonsByCoverage[value]),
))

export interface AnswerCoverageInteractionTrace {
  state: 'not_evaluated' | 'evaluated'
  consumedAssessment?: { coverage: AnswerCoverageValue; reason: AnswerCoverageReason }
  decisions: AnswerCoverageReaction[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object'

const oneOf = <T extends string>(value: unknown, values: readonly T[]): T | undefined =>
  typeof value === 'string' && values.includes(value as T) ? value as T : undefined

export const normalizeAnswerCoverage = (value: unknown): AnswerCoverageAssessment | undefined => {
  if (!isRecord(value)) return undefined
  const availability = oneOf(value.availability, ['assessed', 'not_recorded', 'failed', 'invalid'] as const)
  if (!availability) return undefined
  const coverage = oneOf(value.coverage, ['answered', 'partial', 'unanswered', 'unclear'] as const)
  const reason = oneOf(value.reason, [
    'sufficient_evidence', 'insufficient_evidence', 'conflicting_evidence',
    'ambiguous_request', 'intentional_scope_boundary',
  ] as const)
  const originatingTurnId = typeof value.originatingTurnId === 'string' ? value.originatingTurnId : ''
  const originatingRequestId = typeof value.originatingRequestId === 'string' ? value.originatingRequestId : ''
  if (!originatingTurnId || !originatingRequestId) return undefined
  const hasInvalidSchemaVersion = value.schemaVersion !== undefined
    && (typeof value.schemaVersion !== 'number' || !Number.isInteger(value.schemaVersion) || value.schemaVersion <= 0)
  if (availability === 'assessed' && (!coverage || !reason || hasInvalidSchemaVersion)) {
    return { availability: 'invalid', originatingTurnId, originatingRequestId }
  }
  return {
    availability,
    coverage,
    reason,
    unresolvedRequest: typeof value.unresolvedRequest === 'string' ? value.unresolvedRequest : undefined,
    contextualizedRequest: typeof value.contextualizedRequest === 'string' ? value.contextualizedRequest : undefined,
    originatingTurnId,
    originatingRequestId,
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : undefined,
    assessedAt: typeof value.assessedAt === 'string' ? value.assessedAt : undefined,
  }
}

export const normalizeAnswerCoverageInteractionTrace = (value: unknown): AnswerCoverageInteractionTrace | undefined => {
  if (!isRecord(value) || (value.state !== 'not_evaluated' && value.state !== 'evaluated') || !Array.isArray(value.decisions)) return undefined
  const decisions = value.decisions.flatMap((entry): AnswerCoverageReaction[] => {
    if (!isRecord(entry) || (entry.target !== 'directive' && entry.target !== 'routine') || typeof entry.assessmentRequestId !== 'string' || typeof entry.reasonCode !== 'string') return []
    const decision = oneOf(entry.decision, ['matched', 'applied', 'offered', 'activated', 'skipped', 'suppressed'] as const)
    return decision && typeof entry.targetMessageId === 'string' ? [{ assessmentRequestId: entry.assessmentRequestId, target: entry.target, targetId: typeof entry.targetId === 'string' ? entry.targetId : undefined, decision, reasonCode: entry.reasonCode, routineExecutionId: typeof entry.routineExecutionId === 'string' ? entry.routineExecutionId : undefined, targetMessageId: entry.targetMessageId }] : []
  })
  const consumed = isRecord(value.consumedAssessment)
    && oneOf(value.consumedAssessment.coverage, ['answered', 'partial', 'unanswered', 'unclear'] as const)
    && oneOf(value.consumedAssessment.reason, ['sufficient_evidence', 'insufficient_evidence', 'conflicting_evidence', 'ambiguous_request', 'intentional_scope_boundary'] as const)
    ? { coverage: value.consumedAssessment.coverage as AnswerCoverageValue, reason: value.consumedAssessment.reason as AnswerCoverageReason }
    : undefined
  return { state: value.state, consumedAssessment: consumed, decisions }
}

const COVERAGE_LABELS: Record<AnswerCoverageValue, string> = {
  answered: 'Answered', partial: 'Partly answered', unanswered: 'Unanswered', unclear: 'Needs clarification',
}

export const answerCoverageLabel = (value: AnswerCoverageValue | undefined): string =>
  value ? COVERAGE_LABELS[value] : 'Not assessed'

export const answerCoverageReasonLabel = (value: AnswerCoverageReason | undefined): string =>
  value ? value.replaceAll('_', ' ').replace(/^./, (char) => char.toUpperCase()) : 'Not recorded'

/** Operator-facing wording for the semantic verdict, independent of retrieval outcome. */
export const answerCoverageOutcomePresentation = (coverage: AnswerCoverageValue): {
  title: string
  summary: string
  tone: 'ok' | 'warning' | 'neutral'
} => {
  switch (coverage) {
    case 'answered':
      return {
        title: 'Request answered',
        summary: 'The response resolved the visitor’s request according to the semantic coverage assessment.',
        tone: 'ok',
      }
    case 'unanswered':
      return {
        title: 'Request remains unanswered',
        summary: 'The response did not resolve the visitor’s request. Retrieval and citation facts remain separate below.',
        tone: 'warning',
      }
    case 'partial':
      return {
        title: 'Response leaves part of the request unresolved',
        summary: 'The response resolved part of the request. Retrieval and citation facts remain separate below.',
        tone: 'warning',
      }
    case 'unclear':
      return {
        title: 'Request needs clarification',
        summary: 'The visitor’s request needs clarification before it can be resolved. Retrieval and citation facts remain separate below.',
        tone: 'neutral',
      }
  }
}

/**
 * Applies semantic coverage only when it was actually evaluated. Direct replies,
 * routines, and other non-retrieval turns intentionally keep their activity outcome.
 */
export const answerCoverageAwareOutcome = (
  outcome: DiagnosticPresentation,
  assessment?: AnswerCoverageAssessment,
  options: { legacyUnavailable?: boolean } = {},
): DiagnosticPresentation => {
  if (!assessment) {
    return options.legacyUnavailable
      ? {
          ...outcome,
          title: 'Answer coverage was not assessed',
          summary: 'This legacy turn has no semantic coverage verdict. Its recorded grounding diagnostics remain available below.',
          tone: 'warning',
        }
      : outcome
  }

  if (assessment.availability === 'not_recorded') {
    return outcome
  }

  if (assessment.availability !== 'assessed' || !assessment.coverage) {
    return {
      ...outcome,
      title: 'Answer coverage was not assessed',
      summary: 'This turn has no semantic coverage verdict. Retrieval and citation diagnostics remain available below.',
      tone: 'warning',
    }
  }

  return { ...outcome, ...answerCoverageOutcomePresentation(assessment.coverage) }
}
