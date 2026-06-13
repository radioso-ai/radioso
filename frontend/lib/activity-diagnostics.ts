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

type AnswerOutcome = NonNullable<ChatConversationTurnDebug['answerOutcome']>

/** What drove the reply when it wasn't retrieval or a contact workflow. */
interface RoutineOutcome {
  name?: string
  completed?: boolean
}

// A direct (non-retrieval) reply still has a specific shape — about the
// assistant, a greeting, small talk, or a declined answer. Name it rather than
// flattening everything to "conversational message".
const describeDirectReply = (
  route: RouteDiagnostics | undefined,
  answerOutcome: AnswerOutcome | undefined,
): { title: string; summary: string } => {
  switch (route?.routeReason) {
    case 'assistant_identity':
      return {
        title: 'Answered about the assistant',
        summary: 'The user asked about the assistant itself, so it replied directly without searching documents.',
      }
    case 'conversation_start':
      return {
        title: 'Conversation starter',
        summary: 'The assistant handled a greeting or opening message directly.',
      }
    case 'social_only':
      return {
        title: 'Conversational reply',
        summary: 'The assistant recognized small talk or an acknowledgement and replied directly.',
      }
    default:
      if (answerOutcome === 'no_context_refusal') {
        return {
          title: 'Declined — no grounding',
          summary: 'The assistant did not have grounded information to answer and declined.',
        }
      }
      return {
        title: 'Direct reply',
        summary: 'The assistant answered directly without searching workspace documents.',
      }
  }
}

export function presentActivityOutcome(input: {
  trace?: ActivityTrace
  route?: RouteDiagnostics
  answerOutcome?: AnswerOutcome
  /** Set when the turn was driven by a routine (from the conversation spine). */
  routine?: RoutineOutcome
  /** True when the turn asked the user a clarifying question. */
  clarificationAsked?: boolean
}): DiagnosticPresentation {
  const { trace, route, answerOutcome, routine, clarificationAsked } = input
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

  if (routine) {
    const name = routine.name?.trim()
    const subject = name ? `the “${name}” routine` : 'a routine'
    pushFact(facts, 'Activity route', name ? `Routine · ${name}` : 'Routine')
    pushFact(facts, 'State', routine.completed ? 'Completed' : 'Awaiting user reply')

    return {
      title: 'Routine reply',
      summary: routine.completed
        ? `The reply came from ${subject}, which reached its final step.`
        : `The reply came from ${subject}, which is gathering details and asked the user for more.`,
      facts,
      tone: 'ok',
    }
  }

  if (hasRetrievalWorkflow(trace, route)) {
    const refused = answerOutcome === 'no_context_refusal'
    const counts = summary?.candidateCounts
    pushFact(facts, 'Route', 'Used workspace documents')
    pushFact(facts, 'Reason', routeReason(route))
    pushFact(facts, 'Selected passages', counts?.final)
    pushFact(facts, 'Fallback', summary?.fallbackApplied === true ? 'Used fallback behavior' : summary?.fallbackApplied === false ? 'Not used' : undefined)

    if (refused) {
      return {
        title: 'No answer in workspace documents',
        summary: 'The assistant searched the workspace but didn’t find enough to answer, so it declined.',
        facts,
        tone: 'warning',
      }
    }

    return {
      title: 'Answered from workspace documents',
      summary: counts
        ? `The assistant searched the workspace and selected ${counts.final} passage${counts.final === 1 ? '' : 's'} for the answer.`
        : 'The assistant searched workspace documents before answering.',
      facts,
      tone: summary?.fallbackApplied ? 'warning' : 'ok',
    }
  }

  if (clarificationAsked) {
    pushFact(facts, 'Activity route', 'Clarifying question')
    pushFact(facts, 'Reason', routeReason(route))

    return {
      title: 'Asked a clarifying question',
      summary: 'The assistant asked the user to clarify before answering.',
      facts,
      tone: 'neutral',
    }
  }

  const direct = describeDirectReply(route, answerOutcome)
  pushFact(facts, 'Activity route', direct.title)
  pushFact(facts, 'Reason', routeReason(route))

  return {
    title: direct.title,
    summary: direct.summary,
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
