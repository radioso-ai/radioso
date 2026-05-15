'use client'

import type { ActivitySummary, ActivityTrace } from '@/lib/api'
import { ActivityTraceDetail } from './activity-trace-detail'

interface ActivitySummaryPanelProps {
  activitySummary?: ActivitySummary
  activityTrace?: ActivityTrace
  selectedStageId?: string
  graphMode?: boolean
}

const formatExecutionLabel = (value: string) => value.replaceAll('_', ' ')

export function ActivitySummaryPanel({
  activitySummary,
  activityTrace,
  selectedStageId,
  graphMode = false,
}: ActivitySummaryPanelProps) {
  if (!activitySummary && !activityTrace) {
    return null
  }

  const relaxedRuleLabels = activitySummary?.triggerBackoff?.relaxedRuleIds.map((ruleId) => {
    const matchedRule = activitySummary.triggerAnalysis?.consideredRules.find((rule) => rule.ruleId === ruleId)
    return matchedRule?.triggerInstructionPreview || ruleId
  }) ?? []
  const selectedStage = selectedStageId
    ? activityTrace?.stages.find((stage) => stage.stageId === selectedStageId)
    : undefined
  const status = activitySummary?.status ?? activityTrace?.summary?.status
  const outcome = activitySummary?.outcome ?? activityTrace?.summary?.outcome
  const execution = activitySummary?.execution ?? activityTrace?.summary?.execution
  const candidateCounts = activitySummary?.candidateCounts ?? activityTrace?.summary?.candidateCounts
  const fallbackApplied = activitySummary?.fallbackApplied ?? activityTrace?.summary?.fallbackApplied

  return (
    <div className="space-y-3">
      {activityTrace ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Activity run</p>
            {status ? (
              <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {formatExecutionLabel(status)}
              </span>
            ) : null}
            {outcome ? (
              <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {formatExecutionLabel(outcome)}
              </span>
            ) : null}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-md border border-border/70 bg-background/70 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Stages</p>
              <p className="mt-1 text-sm text-foreground">{activityTrace.stages.length}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-background/70 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Links</p>
              <p className="mt-1 text-sm text-foreground">{activityTrace.links.length}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-background/70 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Duration</p>
              <p className="mt-1 text-sm text-foreground">
                {typeof activityTrace.totalDurationMs === 'number' ? `${activityTrace.totalDurationMs}ms` : 'Not recorded'}
              </p>
            </div>
          </div>
          {selectedStage ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Selected: {selectedStage.label} ({selectedStage.kind})
            </p>
          ) : null}
        </section>
      ) : null}

      {graphMode ? (
        <ActivityTraceDetail
          activityTrace={activityTrace}
          selectedStageId={selectedStageId}
        />
      ) : null}

      {execution ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Execution path</p>
            <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {formatExecutionLabel(execution.surface)}
            </span>
            <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {formatExecutionLabel(execution.path)}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Retrieval {execution.retrievalInvoked ? 'was invoked for this response.' : 'was not invoked for this response.'}
          </p>
        </section>
      ) : null}

      {candidateCounts ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-3">
          <p className="text-sm font-medium text-foreground">Primary counts</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <div className="rounded-md border border-border/70 bg-background/70 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Semantic</p>
              <p className="mt-1 text-sm text-foreground">{candidateCounts.semantic}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-background/70 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Lexical</p>
              <p className="mt-1 text-sm text-foreground">{candidateCounts.lexical}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-background/70 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Merged</p>
              <p className="mt-1 text-sm text-foreground">{candidateCounts.merged}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-background/70 p-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Final</p>
              <p className="mt-1 text-sm text-foreground">{candidateCounts.final}</p>
            </div>
          </div>
          {typeof fallbackApplied === 'boolean' ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Fallback {fallbackApplied ? 'was applied' : 'was not applied'}.
            </p>
          ) : null}
        </section>
      ) : null}

      {activitySummary?.shapeName || activitySummary?.skillDiagnostic ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">Retrieval shape</p>
            {activitySummary.shapeName ? (
              <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {formatExecutionLabel(activitySummary.shapeName)}
              </span>
            ) : null}
            {activitySummary.queryShape ? (
              <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {formatExecutionLabel(activitySummary.queryShape)}
              </span>
            ) : null}
          </div>
          {activitySummary.skillDiagnostic?.selectionReason ? (
            <p className="mt-2 text-sm text-muted-foreground">{activitySummary.skillDiagnostic.selectionReason}</p>
          ) : null}
          {activitySummary.skillDiagnostic ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {activitySummary.skillDiagnostic.skillName} •{' '}
              {formatExecutionLabel(activitySummary.skillDiagnostic.selectionMode)} •{' '}
              {formatExecutionLabel(activitySummary.skillDiagnostic.callerSurface)}
            </p>
          ) : null}
        </section>
      ) : null}

      {activitySummary?.triggerAnalysis ? (
        <section className="rounded-lg border border-border/70 bg-background/60 p-3">
          <p className="text-sm font-medium text-foreground">Trigger analysis</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Status: {activitySummary.triggerAnalysis.status.replaceAll('_', ' ')}. Matched{' '}
            {activitySummary.triggerAnalysis.matchCount} rule
            {activitySummary.triggerAnalysis.matchCount === 1 ? '' : 's'}.
          </p>
          {activitySummary.triggerAnalysis.consideredRules.length > 0 ? (
            <div className="mt-3 space-y-2">
              {activitySummary.triggerAnalysis.consideredRules.map((rule) => (
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

      {activitySummary?.triggerBackoff?.applied ? (
        <section className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-sm font-medium text-foreground">Trigger backoff</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {activitySummary.triggerBackoff.reason === 'weak_filtered_support'
              ? 'Retrieval relaxed trigger-enacted hard filters because the narrowed candidate pool looked too weak to trust.'
              : 'Retrieval relaxed trigger-enacted hard filters after they removed all prepared candidates.'}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Relaxed rules: {relaxedRuleLabels.join(', ') || 'none recorded'}
            {typeof activitySummary.triggerBackoff.restoredCandidateCount === 'number'
              ? ` • Restored candidates: ${activitySummary.triggerBackoff.restoredCandidateCount}`
              : ''}
          </p>
        </section>
      ) : null}

      {!graphMode ? (
        <ActivityTraceDetail
          activityTrace={activityTrace}
          selectedStageId={undefined}
        />
      ) : null}
    </div>
  )
}
