import type { ExecutionState, TestExecution, TestExecutionEvent, TestExecutionHistoryDetail } from './api-agent-revisions'

export interface TestExecutionSideState {
  id: string
  revisionId: string
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
    state: side.state,
    retryable: side.retryable,
    messages: (side.history ?? []).map((entry) => ({
      id: entry.messageId ?? `${side.id}-${entry.turnId}-${entry.role}-${entry.attemptId}`,
      role: entry.role,
      content: entry.content,
      state: 'completed' as const,
      turnId: entry.turnId,
      attemptId: entry.attemptId,
    })),
  }])),
})

/**
 * Reopen a private execution from the server's frozen transcript and attempts.
 * A running persisted attempt remains running: this projection never invents a
 * terminal event or silently starts a replacement turn.
 */
export const hydrateTestExecutionState = (execution: TestExecutionHistoryDetail): TestExecutionState => {
  const currentAttemptBySide = new Map<string, TestExecutionHistoryDetail['attempts'][number]>()
  execution.attempts.forEach((attempt) => {
    const current = currentAttemptBySide.get(attempt.sideId)
    if (!current || attempt.fence >= current.fence) currentAttemptBySide.set(attempt.sideId, attempt)
  })
  const runningAttempt = [...currentAttemptBySide.values()].find((attempt) => attempt.state === 'running')
  return {
    executionId: execution.id,
    generation: execution.generation,
    state: execution.state,
    activeTurnId: runningAttempt?.turnId ?? null,
    activeAttemptId: runningAttempt?.attemptId ?? null,
    sides: Object.fromEntries(execution.sides.map((side) => {
      const currentAttempt = currentAttemptBySide.get(side.id)
      const messages: TestExecutionMessage[] = side.history.map((entry) => ({
        id: entry.messageId ?? `${side.id}-${entry.turnId}-${entry.role}-${entry.attemptId}`,
        role: entry.role,
        content: entry.content,
        state: 'completed',
        turnId: entry.turnId,
        attemptId: entry.attemptId,
      }))
      const hasCurrentAssistant = currentAttempt !== undefined && messages.some((message) =>
        message.role === 'assistant' && message.turnId === currentAttempt.turnId && message.attemptId === currentAttempt.attemptId,
      )
      if (currentAttempt && !hasCurrentAssistant && (currentAttempt.state === 'running' || currentAttempt.state === 'failed')) {
        messages.push({
          id: `${side.id}-${currentAttempt.turnId}-${currentAttempt.attemptId}`,
          role: 'assistant',
          content: currentAttempt.state === 'failed' ? `Test failed: ${currentAttempt.failureCode ?? 'unknown'}` : '',
          state: currentAttempt.state === 'failed' ? 'failed' : 'streaming',
          turnId: currentAttempt.turnId,
          attemptId: currentAttempt.attemptId,
        })
      }
      return [side.id, {
        id: side.id,
        revisionId: side.revision.id,
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

  if (event.type === 'execution_partial') return { ...state, state: 'partial' }
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
        ? { ...side, state: 'completed', retryable: false, messages: updateLastAssistant({ state: 'completed' }) }
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
  // Some valid stream deliveries end after their final `side_completed`
  // event without a redundant execution-level terminal event. Once every
  // side has completed, this turn is resolved and a follow-up is permitted.
  const completed = event.type === 'side_completed' && Object.values(sides).every((candidate) => candidate.state === 'completed')
  return {
    ...state,
    state: completed ? 'completed' : event.type === 'side_failed' ? 'partial' : state.state,
    activeTurnId: completed ? null : state.activeTurnId,
    activeAttemptId: completed ? null : state.activeAttemptId,
    sides,
  }
}
