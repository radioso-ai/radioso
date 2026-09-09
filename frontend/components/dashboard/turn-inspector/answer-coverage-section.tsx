import {
  answerCoverageLabel,
  answerCoverageReasonLabel,
  type AnswerCoverageAssessment,
  type AnswerCoverageInteractionTrace,
} from '@/lib/answer-coverage'

const availabilityLabel: Record<AnswerCoverageAssessment['availability'], string> = {
  assessed: 'Assessed',
  not_recorded: 'Not recorded',
  failed: 'Assessment failed',
  invalid: 'Assessment invalid',
}

export function AnswerCoverageSection({
  assessment,
  interaction,
  isLegacy,
  onOpenTargetMessage,
}: {
  assessment: AnswerCoverageAssessment
  interaction?: AnswerCoverageInteractionTrace
  isLegacy?: boolean
  onOpenTargetMessage?: (messageId: string) => void
}) {
  const assessed = assessment.availability === 'assessed'
  return (
    <section className="rounded-lg border border-border/70 bg-background/60 p-3" data-testid="answer-coverage-diagnostics">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Answer coverage</p>
      <p className="mt-1 text-base font-medium text-foreground">
        {assessed ? answerCoverageLabel(assessment.coverage) : 'Not assessed'}
      </p>
      {isLegacy ? <p className="mt-1 text-xs text-muted-foreground">Legacy evidence: this turn retains its recorded grounding diagnostics, but semantic coverage was not measured.</p> : null}
      <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">
        <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Availability</dt><dd className="mt-0.5 text-sm text-foreground">{availabilityLabel[assessment.availability]}</dd></div>
        {assessed && assessment.reason ? <div><dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Reason</dt><dd className="mt-0.5 text-sm text-foreground">{answerCoverageReasonLabel(assessment.reason)}</dd></div> : null}
        {assessment.contextualizedRequest ? <div className="sm:col-span-2"><dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Contextualized request</dt><dd className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{assessment.contextualizedRequest}</dd></div> : null}
        {assessment.unresolvedRequest ? <div className="sm:col-span-2"><dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Unresolved request</dt><dd className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{assessment.unresolvedRequest}</dd></div> : null}
      </dl>
      {interaction ? (
        <div className="mt-4 space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Coverage reactions</p>
          <p className="text-xs text-muted-foreground">{interaction.state === 'evaluated' ? 'Evaluated' : 'Not evaluated'}{interaction.state === 'evaluated' && interaction.decisions.length === 0 ? ' · no match' : ''}</p>
          {interaction.decisions.map((reaction, index) => (
            <div key={`${reaction.assessmentRequestId}-${index}`} className="rounded-md border border-border/60 px-2 py-1.5 text-sm">
              <span className="font-medium">{reaction.target}</span>{reaction.targetId ? ` · ${reaction.targetId}` : ''} · {reaction.decision.replaceAll('_', ' ')}
              <span className="text-muted-foreground"> · {reaction.reasonCode}</span>
              {onOpenTargetMessage ? <button type="button" className="ml-1 text-primary underline-offset-2 hover:underline" onClick={() => onOpenTargetMessage(reaction.targetMessageId)}>Open linked turn</button> : null}
              {reaction.routineExecutionId ? <span className="ml-1 text-muted-foreground"> · routine execution {reaction.routineExecutionId}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {assessment.originatingTurnId || assessment.originatingRequestId ? <p className="mt-3 text-xs text-muted-foreground">Originating turn {assessment.originatingTurnId || 'unknown'} · request {assessment.originatingRequestId || 'unknown'}{assessment.schemaVersion ? ` · schema ${assessment.schemaVersion}` : ''}</p> : null}
    </section>
  )
}
