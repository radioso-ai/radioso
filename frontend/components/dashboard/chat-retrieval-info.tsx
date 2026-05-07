'use client'

import type { RetrievalInfo, RetrievalTrace } from '@/lib/api'
import { ChatRetrievalTraceDetail } from './chat-retrieval-trace-detail'

interface ChatRetrievalInfoProps {
  retrievalInfo?: RetrievalInfo
  retrievalTrace?: RetrievalTrace
  selectedStageId?: string
  graphMode?: boolean
}

const formatExecutionLabel = (value: string) => value.replaceAll('_', ' ')

export function ChatRetrievalInfo({
  retrievalInfo,
  retrievalTrace,
  selectedStageId,
  graphMode = false,
}: ChatRetrievalInfoProps) {
  if (!retrievalInfo && !retrievalTrace) {
    return null
  }

  const relaxedRuleLabels = retrievalInfo?.triggerBackoff?.relaxedRuleIds.map((ruleId) => {
    const matchedRule = retrievalInfo.triggerAnalysis?.consideredRules.find((rule) => rule.ruleId === ruleId)
    return matchedRule?.triggerInstructionPreview || ruleId
  }) ?? []

  return (
    <div className="space-y-3">
      {retrievalInfo?.execution ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Execution path</p>
            <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {formatExecutionLabel(retrievalInfo.execution.surface)}
            </span>
            <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {formatExecutionLabel(retrievalInfo.execution.path)}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Retrieval {retrievalInfo.execution.retrievalInvoked ? 'was invoked for this response.' : 'was not invoked for this response.'}
          </p>
        </section>
      ) : null}

      {retrievalInfo?.strategy || retrievalInfo?.skillDiagnostic ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Retrieval strategy</p>
            {retrievalInfo.strategy ? (
              <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {formatExecutionLabel(retrievalInfo.strategy)}
              </span>
            ) : null}
            {retrievalInfo.queryShape ? (
              <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {formatExecutionLabel(retrievalInfo.queryShape)}
              </span>
            ) : null}
          </div>
          {retrievalInfo.skillDiagnostic?.selectionReason ? (
            <p className="mt-2 text-sm text-muted-foreground">{retrievalInfo.skillDiagnostic.selectionReason}</p>
          ) : null}
          {retrievalInfo.skillDiagnostic ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {retrievalInfo.skillDiagnostic.skillName} •{' '}
              {formatExecutionLabel(retrievalInfo.skillDiagnostic.selectionMode)} •{' '}
              {formatExecutionLabel(retrievalInfo.skillDiagnostic.callerSurface)}
            </p>
          ) : null}
        </section>
      ) : null}

      {retrievalInfo?.triggerAnalysis ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-3">
          <p className="text-sm font-medium text-foreground">Trigger analysis</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Status: {retrievalInfo.triggerAnalysis.status.replaceAll('_', ' ')}. Matched{' '}
            {retrievalInfo.triggerAnalysis.matchCount} rule
            {retrievalInfo.triggerAnalysis.matchCount === 1 ? '' : 's'}.
          </p>
          {retrievalInfo.triggerAnalysis.consideredRules.length > 0 ? (
            <div className="mt-3 space-y-2">
              {retrievalInfo.triggerAnalysis.consideredRules.map((rule) => (
                <div key={rule.ruleId} className="rounded-md border border-border/70 bg-background/70 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-foreground">{rule.ruleId}</p>
                    <span className="text-xs text-muted-foreground">
                      {rule.matched ? 'matched' : 'not matched'} • {(rule.matchStrength * 100).toFixed(0)}%
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{rule.triggerInstructionPreview}</p>
                  <p className="mt-2 text-sm text-muted-foreground">{rule.reason}</p>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {retrievalInfo?.triggerBackoff?.applied ? (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-sm font-medium text-foreground">Trigger backoff</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {retrievalInfo.triggerBackoff.reason === 'weak_filtered_support'
              ? 'Retrieval relaxed trigger-enacted hard filters because the narrowed candidate pool looked too weak to trust.'
              : 'Retrieval relaxed trigger-enacted hard filters after they removed all prepared candidates.'}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Relaxed rules: {relaxedRuleLabels.join(', ') || 'none recorded'}
            {typeof retrievalInfo.triggerBackoff.restoredCandidateCount === 'number'
              ? ` • Restored candidates: ${retrievalInfo.triggerBackoff.restoredCandidateCount}`
              : ''}
          </p>
        </section>
      ) : null}

      <ChatRetrievalTraceDetail
        retrievalTrace={retrievalTrace}
        selectedStageId={graphMode ? selectedStageId : undefined}
      />
    </div>
  )
}
