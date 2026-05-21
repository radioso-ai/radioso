import type { ActivityStage, ActivityTrace, ChatConversationTurnDebug } from '@/lib/api'

export type DiagnosticTone = 'neutral' | 'ok' | 'warning' | 'error'

export interface DiagnosticFact {
  label: string
  value: string
}

export interface DiagnosticPresentation {
  title: string
  summary: string
  facts: DiagnosticFact[]
  tone: DiagnosticTone
}

type RouteDiagnostics = NonNullable<ChatConversationTurnDebug['route']>

const CONTACT_STAGE_KINDS = new Set([
  'availability_check',
  'intake_collect',
  'trigger_evaluation',
  'draft_build',
  'request_submit',
  'delivery_dispatch',
  'audit_record',
  'skill_execute',
])

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

const asStringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : []

export const humanizeDiagnosticValue = (value: string): string =>
  value
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const sentenceCase = (value: string): string => {
  const humanized = humanizeDiagnosticValue(value)
  return humanized ? `${humanized.charAt(0).toUpperCase()}${humanized.slice(1)}` : value
}

const enabled = (value: unknown): string | undefined => {
  const parsed = asBoolean(value)
  if (parsed === undefined) return undefined
  return parsed ? 'Enabled' : 'Disabled'
}

const yesNo = (value: unknown): string | undefined => {
  const parsed = asBoolean(value)
  if (parsed === undefined) return undefined
  return parsed ? 'Yes' : 'No'
}

const pushFact = (facts: DiagnosticFact[], label: string, value: string | number | undefined | null) => {
  if (value === undefined || value === null || value === '') return
  facts.push({ label, value: String(value) })
}

const findStage = (trace: ActivityTrace | undefined, kind: string): ActivityStage | undefined =>
  trace?.stages.find((stage) => stage.kind === kind)

const hasContactWorkflow = (trace: ActivityTrace | undefined): boolean =>
  Boolean(trace?.stages.some((stage) => CONTACT_STAGE_KINDS.has(stage.kind)))

const hasRetrievalWorkflow = (trace: ActivityTrace | undefined, route?: RouteDiagnostics): boolean => {
  if (route?.retrievalInvoked || route?.routeType === 'retrieval') return true
  if (trace?.summary?.retrievalSkipped === false) return true
  return Boolean(trace?.stages.some((stage) => (
    stage.kind === 'semantic_original'
    || stage.kind === 'semantic_rewritten'
    || stage.kind === 'lexical'
    || stage.kind === 'context_selection'
  )))
}

const routeReason = (route?: RouteDiagnostics): string | undefined => {
  if (!route?.routeReason) return undefined
  switch (route.routeReason) {
    case 'assistant_identity':
      return 'Question about the assistant'
    case 'conversation_start':
      return 'Conversation starter'
    case 'evidence_required':
      return 'Needed workspace knowledge'
    case 'social_only':
      return 'Conversational message'
    default:
      return sentenceCase(String(route.routeReason))
  }
}

export function presentActivityOutcome(input: {
  trace?: ActivityTrace
  route?: RouteDiagnostics
}): DiagnosticPresentation {
  const { trace, route } = input
  const summary = trace?.summary
  const facts: DiagnosticFact[] = []

  if (hasContactWorkflow(trace)) {
    const queued = Boolean(findStage(trace, 'request_submit') ?? findStage(trace, 'skill_execute'))
    const delivery = findStage(trace, 'delivery_dispatch')
    pushFact(facts, 'Workflow', 'Human follow-up')
    pushFact(facts, 'Status', delivery?.status === 'failed' ? 'Delivery failed' : sentenceCase(summary?.status ?? 'pending'))

    return {
      title: queued ? 'Human follow-up queued' : 'Human follow-up workflow started',
      summary: queued
        ? 'The assistant detected that the user wanted a person to follow up and queued a contact request.'
        : 'The assistant detected a possible human follow-up request and checked the workflow.',
      facts,
      tone: delivery?.status === 'failed' ? 'error' : 'ok',
    }
  }

  if (hasRetrievalWorkflow(trace, route)) {
    const counts = summary?.candidateCounts
    pushFact(facts, 'Route', 'Used workspace documents')
    pushFact(facts, 'Reason', routeReason(route))
    pushFact(facts, 'Selected passages', counts?.final)
    pushFact(facts, 'Fallback', summary?.fallbackApplied === true ? 'Used fallback behavior' : summary?.fallbackApplied === false ? 'Not used' : undefined)

    return {
      title: 'Used workspace documents',
      summary: counts
        ? `The assistant searched the workspace and selected ${counts.final} passage${counts.final === 1 ? '' : 's'} for the answer.`
        : 'The assistant searched workspace documents before answering.',
      facts,
      tone: summary?.fallbackApplied ? 'warning' : 'ok',
    }
  }

  pushFact(facts, 'Activity route', 'Direct assistant reply')
  pushFact(facts, 'Reason', routeReason(route))

  return {
    title: 'Direct assistant reply',
    summary: 'The assistant recognized this as a conversational message and replied directly.',
    facts,
    tone: 'neutral',
  }
}

export function presentRunParameters(trace: ActivityTrace | undefined): DiagnosticPresentation | null {
  if (!trace) return null

  if (hasRetrievalWorkflow(trace)) {
    const context = findStage(trace, 'context')
    const interpretation = findStage(trace, 'query_interpretation')
    const selection = findStage(trace, 'context_selection')
    const prompt = findStage(trace, 'prompt_assembly')
    const shape = findStage(trace, 'shape_selection')

    const contextSettings = asRecord(context?.settings)
    const interpretationOutputs = asRecord(interpretation?.outputs)
    const selectionSettings = asRecord(selection?.settings)
    const promptSettings = asRecord(prompt?.settings)
    const shapeOutputs = asRecord(shape?.outputs)
    const facts: DiagnosticFact[] = []

    pushFact(facts, 'Query rewrite', enabled(contextSettings.queryRewriteEnabled))
    pushFact(facts, 'Meaning search limit', asNumber(contextSettings.vectorTopK))
    pushFact(facts, 'Minimum similarity', asNumber(contextSettings.similarityThreshold))
    pushFact(facts, 'Rerank', enabled(selectionSettings.effectiveRerankEnabled ?? selectionSettings.rerankEnabled ?? contextSettings.rerankEnabled))
    pushFact(facts, 'Rerank limit', asNumber(selectionSettings.rerankTopK ?? contextSettings.rerankTopK))
    pushFact(facts, 'Citation display', enabled(promptSettings.citationDisplayEnabled))
    pushFact(facts, 'Language policy', asString(promptSettings.responseLanguagePolicy) ?? asString(interpretationOutputs.responseLanguagePolicy))
    pushFact(facts, 'Answer strategy', asString(shapeOutputs.shapeName)?.replaceAll('_', ' '))

    return facts.length
      ? {
          title: 'Retrieval parameters',
          summary: 'These settings shaped how workspace documents were searched and ranked.',
          facts,
          tone: 'neutral',
        }
      : null
  }

  if (hasContactWorkflow(trace)) {
    const availability = findStage(trace, 'availability_check')
    const trigger = findStage(trace, 'trigger_evaluation')
    const intake = findStage(trace, 'intake_collect')
    const delivery = findStage(trace, 'delivery_dispatch')
    const availabilityOutputs = asRecord(availability?.outputs)
    const triggerOutputs = asRecord(trigger?.outputs)
    const intakeOutputs = asRecord(intake?.outputs)
    const deliveryOutputs = asRecord(delivery?.outputs)
    const missing = asStringList(intakeOutputs.missing)
    const invalid = asStringList(intakeOutputs.invalid)
    const facts: DiagnosticFact[] = []

    pushFact(facts, 'Contact workflow', yesNo(availabilityOutputs.configured) === 'Yes' ? 'Ready' : yesNo(availabilityOutputs.configured) === 'No' ? 'Not configured' : undefined)
    pushFact(facts, 'Trigger source', asString(triggerOutputs.triggerSource)?.replaceAll('_', ' '))
    pushFact(facts, 'Missing details', missing.length ? missing.join(', ') : undefined)
    pushFact(facts, 'Invalid details', invalid.length ? invalid.join(', ') : undefined)
    pushFact(facts, 'Delivery state', asString(deliveryOutputs.status)?.replaceAll('_', ' '))

    return {
      title: 'Contact workflow parameters',
      summary: facts.length
        ? 'These settings and collected details shaped the human follow-up workflow.'
        : 'This workflow did not expose additional beginner-facing parameters.',
      facts: facts.length ? facts : [{ label: 'Workflow', value: trace.summary?.skillName ?? trace.summary?.path ?? 'Human follow-up' }],
      tone: 'neutral',
    }
  }

  return null
}
