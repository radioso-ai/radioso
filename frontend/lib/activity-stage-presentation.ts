import type { ActivityStage, ActivityTrace } from '@/lib/api'

/**
 * Operator-facing vocabulary for {@link ActivityTrace} stages: the one place a
 * stage kind gets its short label, its one-line summary, and whether it needs a
 * look. The inline stage list and the turn flow graph both read from here, so a
 * stage never goes by two names.
 */

export type StageTone = 'good' | 'warn' | 'bad' | 'muted' | 'neutral'

type StageStatus = ActivityStage['status']

interface StageAttention {
  tone: StageTone
  /** Why the stage needs a look; absent for neutral and muted stages. */
  reason?: string
}

const DISPLAY_LABELS: Record<string, string> = {
  routing: 'Route',
  context: 'Context',
  query_interpretation: 'Interpret query',
  trigger_analysis: 'Triggers',
  shape_selection: 'Strategy',
  semantic_original: 'Semantic search',
  semantic_rewritten: 'Semantic search',
  lexical: 'Keyword search',
  candidate_preparation: 'Merge',
  context_selection: 'Rank',
  prompt_assembly: 'Prompt',
  diagnostics: 'Check',
  answer_outcome: 'Answer',
  generation: 'Generate',
  availability_check: 'Contact settings',
  intake_collect: 'Collect details',
  trigger_evaluation: 'Follow-up intent',
  draft_build: 'Prepare request',
  request_submit: 'Queue request',
  delivery_dispatch: 'Notify team',
  audit_record: 'Audit log',
  skill_execute: 'Run workflow',
  conversation_summary: 'Conversation summary',
}

const SEMANTIC_SEARCH_KINDS = new Set(['semantic_original', 'semantic_rewritten'])
const LEXICAL_SEARCH_KINDS = new Set(['lexical'])

export const activityStageLabel = (stage: ActivityStage): string => DISPLAY_LABELS[stage.kind] ?? stage.label

const chunkCount = (stage: ActivityStage) => {
  if (typeof stage.metrics?.candidateCount === 'number') {
    return stage.metrics.candidateCount
  }
  if (typeof stage.metrics?.finalContextCount === 'number') {
    return stage.metrics.finalContextCount
  }
  if (typeof stage.metrics?.mergedCount === 'number') {
    return stage.metrics.mergedCount
  }
  if (typeof stage.metrics?.promptContextCount === 'number') {
    return stage.metrics.promptContextCount
  }
  return null
}

export const activityStageSummary = (stage: ActivityStage): string => {
  const outputs = (stage.outputs ?? {}) as Record<string, unknown>
  const inputs = (stage.inputs ?? {}) as Record<string, unknown>
  const metrics = stage.metrics ?? {}

  switch (stage.kind) {
    case 'routing': {
      const retrievalInvoked = outputs.retrievalInvoked as boolean | undefined
      if (retrievalInvoked === true) return 'evidence needed'
      if (stage.reason === 'assistant_identity') return 'identity'
      if (retrievalInvoked === false) return 'direct'
      return stage.reason ?? ''
    }
    case 'context': {
      const count = metrics.selectedHistoryCount
      return typeof count === 'number' ? `${count} message${count === 1 ? '' : 's'}` : ''
    }
    case 'query_interpretation': {
      const query = outputs.effectiveQuery as string | undefined
      if (query) return query.length > 20 ? `"${query.slice(0, 20)}…"` : `"${query}"`
      return stage.status === 'skipped' ? 'skipped' : ''
    }
    case 'trigger_analysis': {
      const matchCount = metrics.matchCount
      if (typeof matchCount === 'number') return matchCount === 0 ? 'none' : `${matchCount} matched`
      return stage.status === 'skipped' ? 'skipped' : ''
    }
    case 'shape_selection': {
      const shapeName = outputs.shapeName as string | undefined
      return shapeName?.replaceAll('_', ' ') ?? ''
    }
    case 'semantic_original':
    case 'semantic_rewritten':
    case 'lexical': {
      const count = metrics.candidateCount
      return typeof count === 'number' ? `${count} passages` : ''
    }
    case 'candidate_preparation': {
      const merged = metrics.mergedCount
      const scored = metrics.scoredCount
      if (typeof merged === 'number' && typeof scored === 'number' && merged !== scored)
        return `${merged} → ${scored}`
      return typeof merged === 'number' ? `${merged} merged` : ''
    }
    case 'context_selection': {
      const final = metrics.finalContextCount
      return typeof final === 'number' ? `top ${final}` : ''
    }
    case 'prompt_assembly': {
      const citations = metrics.citationCount
      return typeof citations === 'number' ? `${citations} citations` : ''
    }
    case 'diagnostics':
      return outputs.fallbackApplied ? 'fallback' : 'ok'
    case 'answer_outcome': {
      const skillOutcome = outputs.skillOutcome as string | undefined
      if (skillOutcome) return skillOutcome.replaceAll('_', ' ')
      const outcome = outputs.outcome as string | undefined
      if (outcome === 'non_retrieval_response' || outcome === 'non_retrieval_answer') return 'direct reply'
      return outcome?.replaceAll('_', ' ') ?? ''
    }
    case 'generation': {
      const model = inputs.model as string | undefined
      return model ?? ''
    }
    case 'conversation_summary': {
      const chars = outputs.summaryChars as number | undefined
      if (typeof chars === 'number') return `${chars} chars`
      return stage.status === 'skipped' ? 'none yet' : ''
    }
    default: {
      const count = chunkCount(stage)
      if (typeof count === 'number') return `${count}`
      return stage.reason ?? ''
    }
  }
}

/** The sub-question a fanned-out search branch served, when the branch names one. */
export const activityStageQualifier = (stage: ActivityStage): string | undefined => {
  const label = stage.settings?.subqueryLabel
  return typeof label === 'string' && label.trim() ? label : undefined
}

/** How a recorded stage status reads at a glance, for spine and capability stages alike. */
export const statusTone = (status: StageStatus | undefined): StageTone => {
  switch (status) {
    case 'failed':
      return 'bad'
    case 'fallback':
    case 'rejected':
      return 'warn'
    case 'skipped':
    case 'unavailable':
      return 'muted'
    default:
      return 'neutral'
  }
}

/**
 * Whether a stage needs a look, from its status and structure only. A semantic
 * search that came back empty is flagged even though it ran cleanly; an empty
 * keyword search is routine and is not.
 */
export const activityStageAttention = (stage: ActivityStage): StageAttention => {
  const tone = statusTone(stage.status)
  if (tone === 'muted') return { tone }
  if (tone !== 'neutral') return { tone, reason: stage.status }
  if (SEMANTIC_SEARCH_KINDS.has(stage.kind) && stage.metrics?.candidateCount === 0) {
    return { tone: 'warn', reason: 'no results' }
  }
  return { tone: 'neutral' }
}

export const formatStageDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`

/**
 * A stage's measured wall time, when it took any. Only a stage with a start is a
 * real span; the answer-outcome stages carry the whole turn's latency without one.
 */
export const activityStageDurationMs = (stage: ActivityStage): number | undefined =>
  stage.startedAt && typeof stage.durationMs === 'number' && stage.durationMs > 0 ? stage.durationMs : undefined

const sumMetric = (stages: readonly ActivityStage[], metric: string): number | undefined => {
  const values = stages.flatMap((stage) => {
    const value = stage.metrics?.[metric]
    return typeof value === 'number' ? [value] : []
  })
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined
}

const metricOf = (trace: ActivityTrace, kind: string, metric: string): number | undefined => {
  const value = trace.stages.find((stage) => stage.kind === kind)?.metrics?.[metric]
  return typeof value === 'number' ? value : undefined
}

/**
 * One line for a whole trace: the evidence funnel when it searched
 * (`30 semantic · 0 keyword → 9 used`), otherwise nothing.
 */
export const activityTraceSummary = (trace: ActivityTrace): string | undefined => {
  const semantic = trace.stages.filter((stage) => SEMANTIC_SEARCH_KINDS.has(stage.kind))
  const lexical = trace.stages.filter((stage) => LEXICAL_SEARCH_KINDS.has(stage.kind))
  if (semantic.length === 0 && lexical.length === 0) return undefined

  const found = [
    semantic.length ? `${sumMetric(semantic, 'candidateCount') ?? 0} semantic` : undefined,
    lexical.length ? `${sumMetric(lexical, 'candidateCount') ?? 0} keyword` : undefined,
  ].filter(Boolean).join(' · ')
  const used = metricOf(trace, 'context_selection', 'finalContextCount')
  return used === undefined ? found : `${found} → ${used} used`
}
