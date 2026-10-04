import type { ExecutionState, TestExecution, TestExecutionEvent, TestExecutionHistoryDetail } from './api-agent-revisions'
import type { TurnTraceEnvelope } from './api-types'

export interface TestExecutionSideState {
  id: string
  revisionId: string
  conversationId?: string
  state: ExecutionState | 'ready'
  errorCode?: string
  retryable: boolean
  recoveryAvailable?: boolean
  messages: TestExecutionMessage[]
}

interface TestExecutionMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  state: 'streaming' | 'completed' | 'failed'
  turnId: string
  attemptId: string
  persistedAssistantMessageId?: string
  turnTrace?: TurnTraceEnvelope
}

export interface TestExecutionState {
  executionId: string
  generation: number
  state: ExecutionState
  activeTurnId: string | null
  activeAttemptId: string | null
  sides: Record<string, TestExecutionSideState>
}

/**
 * Aggregate independent side outcomes into one execution status. A side still
 * running keeps the whole execution running; once none are, a side failure
 * makes the execution partial rather than uniformly failed, matching how a
 * mid-turn side failure is already surfaced everywhere else in this state
 * machine (see `reduceTestExecutionEvent` and `failTestExecutionSide`). Shared
 * by the initializer and the mid-stream finalizer so a freshly started
 * execution and a stream that ends early agree on the same status.
 */
const deriveExecutionState = (sideStates: ReadonlyArray<ExecutionState | 'ready'>): ExecutionState =>
  sideStates.some((sideState) => sideState === 'running')
    ? 'running'
    : sideStates.some((sideState) => sideState === 'failed')
      ? 'partial'
      : 'completed'

export const initializeTestExecutionState = (execution: TestExecution): TestExecutionState => ({
  executionId: execution.id,
  generation: execution.generation,
  state: deriveExecutionState(execution.sides.map((side) => side.state)),
  activeTurnId: null,
  activeAttemptId: null,
  sides: Object.fromEntries(execution.sides.map((side) => [side.id, {
    id: side.id,
    revisionId: side.revision.id,
    conversationId: side.conversationId,
    state: side.state,
    retryable: side.retryable,
    messages: (side.history ?? []).map((entry) => ({
      id: entry.messageId ?? `${side.id}-${entry.turnId}-${entry.role}-${entry.attemptId}`,
      role: entry.role,
      content: entry.content,
      state: 'completed' as const,
      turnId: entry.turnId,
      attemptId: entry.attemptId,
      persistedAssistantMessageId: entry.role === 'assistant' ? entry.messageId : undefined,
      turnTrace: entry.role === 'assistant' ? entry.turnTrace : undefined,
    })),
  }])),
})

type PersistedAttempt = TestExecutionHistoryDetail['attempts'][number]
type PersistedSide = TestExecutionHistoryDetail['sides'][number]

/**
 * One side's latest attempt per turn. A retry supersedes an attempt with a higher
 * fence, but every new turn starts again at fence 1, so fences only order attempts
 * within one turn — the same grouping the backend's turn read model uses.
 */
const latestAttemptByTurn = (attempts: readonly PersistedAttempt[], sideId: string): Map<string, PersistedAttempt> => {
  const latest = new Map<string, PersistedAttempt>()
  attempts.forEach((attempt) => {
    if (attempt.sideId !== sideId) return
    const current = latest.get(attempt.turnId)
    if (!current || attempt.fence > current.fence) latest.set(attempt.turnId, attempt)
  })
  return latest
}

/** The side's latest turn: the one its last operator message opened. */
const currentTurnId = (history: PersistedSide['history']): string | undefined =>
  history.filter((entry) => entry.role === 'user').at(-1)?.turnId

/**
 * The assistant slot of a turn that has no answer in the history: a failed turn
 * keeps its failure in place, and only the current turn can still be running.
 */
const unansweredPlaceholder = (sideId: string, attempt: PersistedAttempt | undefined, isCurrentTurn: boolean): TestExecutionMessage | null => {
  if (!attempt || !(attempt.state === 'failed' || (attempt.state === 'running' && isCurrentTurn))) return null
  return {
    id: `${sideId}-${attempt.turnId}-${attempt.attemptId}`,
    role: 'assistant',
    content: attempt.state === 'failed' ? `Test failed: ${attempt.failureCode ?? 'unknown'}` : '',
    state: attempt.state === 'failed' ? 'failed' : 'streaming',
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
  }
}

/** A side's persisted history as messages, with each unanswered turn's placeholder right after that turn. */
const hydrateSideMessages = (side: PersistedSide, latestByTurn: Map<string, PersistedAttempt>, current: string | undefined): TestExecutionMessage[] => {
  const answeredTurnIds = new Set(side.history.filter((entry) => entry.role === 'assistant').map((entry) => entry.turnId))
  const lastIndexByTurn = new Map(side.history.map((entry, index) => [entry.turnId, index] as const))
  return side.history.flatMap((entry, index) => {
    const message: TestExecutionMessage = {
      id: entry.messageId ?? `${side.id}-${entry.turnId}-${entry.role}-${entry.attemptId}`,
      role: entry.role,
      content: entry.content,
      state: 'completed',
      turnId: entry.turnId,
      attemptId: entry.attemptId,
      persistedAssistantMessageId: entry.role === 'assistant' ? entry.messageId : undefined,
      turnTrace: entry.role === 'assistant' ? entry.turnTrace : undefined,
    }
    const endsUnansweredTurn = lastIndexByTurn.get(entry.turnId) === index && !answeredTurnIds.has(entry.turnId)
    const placeholder = endsUnansweredTurn
      ? unansweredPlaceholder(side.id, latestByTurn.get(entry.turnId), entry.turnId === current)
      : null
    return placeholder ? [message, placeholder] : [message]
  })
}

/**
 * Reopen a private execution from the server's frozen transcript and attempts.
 * A running persisted attempt remains running: this projection never invents a
 * terminal event or silently starts a replacement turn. A failed turn stays in
 * the transcript even after a later message superseded it.
 */
export const hydrateTestExecutionState = (execution: TestExecutionHistoryDetail): TestExecutionState => {
  const sides = execution.sides.map((side) => {
    const latestByTurn = latestAttemptByTurn(execution.attempts, side.id)
    const current = currentTurnId(side.history)
    return { side, latestByTurn, current, currentAttempt: current === undefined ? undefined : latestByTurn.get(current) }
  })
  const runningAttempt = sides.map(({ currentAttempt }) => currentAttempt).find((attempt) => attempt?.state === 'running')
  return {
    executionId: execution.id,
    generation: execution.generation,
    state: execution.state,
    activeTurnId: runningAttempt?.turnId ?? null,
    activeAttemptId: runningAttempt?.attemptId ?? null,
    sides: Object.fromEntries(sides.map(({ side, latestByTurn, current, currentAttempt }) => {
      const messages = hydrateSideMessages(side, latestByTurn, current)
      return [side.id, {
        id: side.id,
        revisionId: side.revision.id,
        conversationId: side.conversationId,
        state: side.state,
        retryable: side.retryable,
        recoveryAvailable: currentAttempt?.state === 'running' && Boolean(currentAttempt.leaseExpiresAt && new Date(currentAttempt.leaseExpiresAt).getTime() <= Date.now()),
        errorCode: side.state === 'failed' && currentAttempt?.state === 'failed' ? currentAttempt.failureCode ?? undefined : undefined,
        messages,
      }]
    })),
  }
}

/** Add the one operator message to every independently pinned test side. */
export const beginTestExecutionTurn = (state: TestExecutionState, message: string, turnId: string, attemptId: string): TestExecutionState => ({
  ...state,
  activeTurnId: turnId,
  activeAttemptId: attemptId,
  sides: Object.fromEntries(Object.entries(state.sides).map(([sideId, side]) => [sideId, {
    ...side,
    state: 'running' as const,
    errorCode: undefined,
    retryable: false,
    messages: [...side.messages,
      { id: `${sideId}-${turnId}-user`, role: 'user' as const, content: message, state: 'completed' as const, turnId, attemptId },
      { id: `${sideId}-${turnId}-assistant`, role: 'assistant' as const, content: '', state: 'streaming' as const, turnId, attemptId },
    ],
  }])),
})

export const beginTestExecutionRetry = (
  state: TestExecutionState,
  sideId: string,
  attemptId: string,
): TestExecutionState => {
  const current = state.sides[sideId]
  if (!current) return state
  const lastAssistant = [...current.messages].reverse().find((message) => message.role === 'assistant')
  const retryTurnId = lastAssistant?.turnId ?? attemptId
  return {
    ...state,
    state: 'running',
    activeTurnId: lastAssistant?.turnId ?? attemptId,
    activeAttemptId: attemptId,
    sides: {
      ...state.sides,
      [sideId]: {
        ...current,
        state: 'running',
        retryable: false,
        errorCode: undefined,
        // A retry is a new transport attempt for the same assistant reply, not
        // another reply in the transcript. Keep the user message and sibling
        // evidence intact while replacing the failed placeholder in place.
        messages: lastAssistant
          ? current.messages.map((message) => message.id === lastAssistant.id ? {
            ...message,
            id: `${sideId}-${retryTurnId}-${attemptId}`,
            content: '',
            state: 'streaming',
            attemptId,
          } : message)
          : current.messages,
      },
    },
  }
}

/** Resolve a transport that closed without an execution terminal event. */
export const finalizeTestExecutionStream = (state: TestExecutionState, code: string): TestExecutionState => {
  const incompleteSideIds = Object.values(state.sides).filter((side) => side.state === 'running').map((side) => side.id)
  if (!incompleteSideIds.length) {
    return { ...state, state: deriveExecutionState(Object.values(state.sides).map((side) => side.state)) }
  }
  return incompleteSideIds.reduce((current, sideId) => failTestExecutionSide(current, sideId, code), state)
}

export const failTestExecutionSide = (state: TestExecutionState, sideId: string, code: string): TestExecutionState => {
  const side = state.sides[sideId]
  if (!side) return state
  const lastAssistant = [...side.messages].reverse().find((message) => message.role === 'assistant')
  return {
    ...state,
    state: 'partial',
    sides: {
      ...state.sides,
      [sideId]: {
        ...side,
        state: 'failed',
        errorCode: code,
        retryable: true,
        messages: lastAssistant ? side.messages.map((message) => message.id === lastAssistant.id ? { ...message, content: message.content || 'The response stream ended before an answer was complete.', state: 'failed' } : message) : side.messages,
      },
    },
  }
}

/** Ignore delayed events from an execution that the operator has already replaced. */
export const reduceTestExecutionEvent = (
  state: TestExecutionState,
  event: TestExecutionEvent,
): TestExecutionState => {
  if (event.executionId !== state.executionId || event.generation !== state.generation || event.turnId !== state.activeTurnId || event.attemptId !== state.activeAttemptId) {
    return state
  }

  // A partial turn is settled: its failed side stays retryable, and the next message may start.
  if (event.type === 'execution_partial') return { ...state, state: 'partial', activeTurnId: null, activeAttemptId: null }
  if (event.type === 'execution_completed') {
    return { ...state, state: 'completed', activeTurnId: null, activeAttemptId: null }
  }

  const side = state.sides[event.sideId]
  if (!side) return state

  const lastAssistantMessage = [...side.messages].reverse().find((message) =>
    message.role === 'assistant' && message.turnId === event.turnId && message.attemptId === event.attemptId,
  )
  const updateLastAssistant = (update: Partial<TestExecutionMessage>) => lastAssistantMessage
    ? side.messages.map((message) => message.id === lastAssistantMessage.id ? { ...message, ...update } : message)
    : side.messages

  const nextSide: TestExecutionSideState = event.type === 'side_started'
    ? { ...side, state: 'running', errorCode: undefined, retryable: false, messages: updateLastAssistant({ state: 'streaming' }) }
    : event.type === 'message_delta'
      ? {
        ...side,
        state: 'running',
        messages: updateLastAssistant({ content: `${lastAssistantMessage?.content ?? ''}${event.delta}`, state: 'streaming' }),
      }
      : event.type === 'side_completed'
        ? {
          ...side,
          state: 'completed',
          retryable: false,
          messages: updateLastAssistant({
            state: 'completed',
            persistedAssistantMessageId: event.messageId,
            turnTrace: event.turnTrace,
          }),
        }
      : event.type === 'side_failed'
          ? {
            ...side,
            state: 'failed',
            errorCode: event.code,
            retryable: event.retryable,
            messages: updateLastAssistant({ content: lastAssistantMessage?.content || `Test failed: ${event.code}`, state: 'failed' }),
          }
          : side

  const sides = { ...state.sides, [side.id]: nextSide }
  // Some valid stream deliveries end after their final side event without a
  // redundant execution-level terminal event. Once no side is still running,
  // this turn is resolved and a follow-up is permitted, a failed side included.
  const sideStates = Object.values(sides).map((candidate) => candidate.state)
  const settled = (event.type === 'side_completed' || event.type === 'side_failed') && !sideStates.includes('running')
  const completed = settled && sideStates.every((sideState) => sideState === 'completed')
  return {
    ...state,
    state: completed ? 'completed' : settled || event.type === 'side_failed' ? 'partial' : state.state,
    activeTurnId: settled ? null : state.activeTurnId,
    activeAttemptId: settled ? null : state.activeAttemptId,
    sides,
  }
}
