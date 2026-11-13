import { describe, expect, it } from 'vitest'

import { beginTestExecutionRetry, beginTestExecutionTurn, failTestExecutionSide, finalizeTestExecutionStream, hydrateTestExecutionState, initializeTestExecutionState, reduceTestExecutionEvent } from '@/lib/agent-test-execution-state'

const state = () => initializeTestExecutionState({
  id: 'execution-1',
  generation: 2,
  mode: 'compare',
  skillEffects: 'suppressed',
  sides: [
    { id: 'left', revision: { id: 'revision-7', label: 'Published', kind: 'published', versionNumber: 7, createdAt: '' }, conversationId: 'left-chat', state: 'running', retryable: false },
    { id: 'right', revision: { id: 'revision-8', label: 'Draft', kind: 'candidate', versionNumber: null, createdAt: '' }, conversationId: 'right-chat', state: 'running', retryable: false },
  ],
})

describe('agent test execution state', () => {
  it('applies messages only to the pinned execution and side', () => {
    const initial = beginTestExecutionTurn(state(), 'Hello', 'turn-1', 'attempt-1')
    const updated = reduceTestExecutionEvent(initial, {
      type: 'message_delta', executionId: 'execution-1', generation: 2, sideId: 'right', delta: 'Draft answer', turnId: 'turn-1', attemptId: 'attempt-1',
    })

    expect(updated.sides.right.messages.at(-1)?.content).toBe('Draft answer')
    expect(updated.sides.left.messages.at(-1)?.content).toBe('')
  })

  it('fences a late stream event after the operator starts a new test', () => {
    const initial = state()
    const updated = reduceTestExecutionEvent(initial, {
      type: 'message_delta', executionId: 'execution-old', generation: 1, sideId: 'right', delta: 'late answer', turnId: 'turn-old', attemptId: 'attempt-old',
    })

    expect(updated).toBe(initial)
  })

  it('fences an old turn within one execution when the backend supplies turn identity', () => {
    const firstTurn = beginTestExecutionTurn(state(), 'First', 'turn-1', 'attempt-1')
    const secondTurn = beginTestExecutionTurn(firstTurn, 'Second', 'turn-2', 'attempt-2')

    const updated = reduceTestExecutionEvent(secondTurn, {
      type: 'message_delta', executionId: 'execution-1', generation: 2, sideId: 'right', turnId: 'turn-1', attemptId: 'attempt-1', delta: 'late first answer',
    })

    expect(updated.sides.right.messages.at(-1)?.content).toBe('')
    expect(updated.sides.right.messages.find((message) => message.turnId === 'turn-1' && message.role === 'assistant')?.content).toBe('')
  })

  it('clears completed turn identities so a follow-up can begin after every side completes', () => {
    const active = beginTestExecutionTurn(state(), 'First', 'turn-1', 'attempt-1')
    const completed = reduceTestExecutionEvent(active, {
      type: 'execution_completed', executionId: 'execution-1', generation: 2, turnId: 'turn-1', attemptId: 'attempt-1',
    })

    expect(completed.activeTurnId).toBeNull()
    expect(completed.activeAttemptId).toBeNull()
    expect(beginTestExecutionTurn(completed, 'Follow-up', 'turn-2', 'attempt-2').activeTurnId).toBe('turn-2')
  })

  it('resolves a turn after every side completes when the stream omits execution_completed', () => {
    const active = beginTestExecutionTurn(state(), 'First', 'turn-1', 'attempt-1')
    const leftCompleted = reduceTestExecutionEvent(active, {
      type: 'side_completed', executionId: 'execution-1', generation: 2, sideId: 'left', messageId: 'message-left', turnId: 'turn-1', attemptId: 'attempt-1',
    })
    const completed = reduceTestExecutionEvent(leftCompleted, {
      type: 'side_completed', executionId: 'execution-1', generation: 2, sideId: 'right', messageId: 'message-right', turnId: 'turn-1', attemptId: 'attempt-1',
    })

    expect(completed).toMatchObject({ state: 'completed', activeTurnId: null, activeAttemptId: null })
    expect(beginTestExecutionTurn(completed, 'Follow-up', 'turn-2', 'attempt-2').activeTurnId).toBe('turn-2')
  })

  it('settles a turn once every side has answered or failed, so a failed side does not block the next message', () => {
    const active = beginTestExecutionTurn(state(), 'First', 'turn-1', 'attempt-1')
    const leftFailed = reduceTestExecutionEvent(active, {
      type: 'side_failed', executionId: 'execution-1', generation: 2, sideId: 'left', code: 'runner_failed', retryable: true, turnId: 'turn-1', attemptId: 'attempt-1',
    })
    expect(leftFailed.activeTurnId).toBe('turn-1')
    const settled = reduceTestExecutionEvent(leftFailed, {
      type: 'side_completed', executionId: 'execution-1', generation: 2, sideId: 'right', messageId: 'message-right', turnId: 'turn-1', attemptId: 'attempt-1',
    })

    expect(settled).toMatchObject({ state: 'partial', activeTurnId: null, activeAttemptId: null })
    expect(settled.sides.left).toMatchObject({ state: 'failed', retryable: true })
    expect(beginTestExecutionTurn(settled, 'Follow-up', 'turn-2', 'attempt-2').activeTurnId).toBe('turn-2')
  })

  it('settles a turn on execution_partial', () => {
    const active = beginTestExecutionTurn(state(), 'First', 'turn-1', 'attempt-1')
    const partial = reduceTestExecutionEvent(active, {
      type: 'execution_partial', executionId: 'execution-1', generation: 2, turnId: 'turn-1', attemptId: 'attempt-1',
    })

    expect(partial).toMatchObject({ state: 'partial', activeTurnId: null, activeAttemptId: null })
  })

  it('keeps the cards a completion carries on its reply, and none when it carries none', () => {
    const active = beginTestExecutionTurn(state(), 'Flats in Mitte?', 'turn-1', 'attempt-1')
    const block = {
      type: 'item_list' as const, id: 'b1', layout: 'carousel' as const, selection: 'none' as const, caption: 'Flats in Mitte',
      items: [{ key: '/structuredContent/0', title: 'Loft on Torstrasse', actions: [{ type: 'open' as const, url: 'https://homes.example/listings/loft' }] }],
    }
    const withCards = reduceTestExecutionEvent(active, {
      type: 'side_completed', executionId: 'execution-1', generation: 2, sideId: 'left', messageId: 'message-left',
      answer: 'One loft fits.', turnId: 'turn-1', attemptId: 'attempt-1', blocks: [block],
    })
    const withoutCards = reduceTestExecutionEvent(withCards, {
      type: 'side_completed', executionId: 'execution-1', generation: 2, sideId: 'right', messageId: 'message-right',
      answer: 'One loft fits.', turnId: 'turn-1', attemptId: 'attempt-1', blocks: [],
    })

    expect(withoutCards.sides.left.messages.at(-1)?.blocks).toEqual([block])
    expect(withoutCards.sides.right.messages.at(-1)).not.toHaveProperty('blocks')
  })

  it('keeps the completed response identity and trace for eval capture and turn debug', () => {
    const active = beginTestExecutionTurn(state(), 'First', 'turn-1', 'attempt-1')
    const trace = { version: 1, spine: { stages: [] } } as never
    const completed = reduceTestExecutionEvent(active, {
      type: 'side_completed', executionId: 'execution-1', generation: 2, sideId: 'left',
      messageId: 'assistant-message-1', turnId: 'turn-1', attemptId: 'attempt-1', turnTrace: trace,
    })

    expect(completed.sides.left.messages.at(-1)).toMatchObject({
      persistedAssistantMessageId: 'assistant-message-1',
      turnTrace: trace,
    })
  })

  it('streams deltas into the reply and settles it on the stored answer the completion carries', () => {
    const active = beginTestExecutionTurn(state(), 'Refunds?', 'turn-1', 'attempt-1')
    const streamed = ['  Refunds take [[1]]', ' five days.\n'].reduce((current, delta) => reduceTestExecutionEvent(current, {
      type: 'message_delta', executionId: 'execution-1', generation: 2, sideId: 'left', delta, turnId: 'turn-1', attemptId: 'attempt-1',
    }), active)
    expect(streamed.sides.left.messages.at(-1)).toMatchObject({ content: '  Refunds take [[1]] five days.\n', state: 'streaming' })

    const completed = reduceTestExecutionEvent(streamed, {
      type: 'side_completed', executionId: 'execution-1', generation: 2, sideId: 'left', messageId: 'message-left', answer: 'Refunds take five days.', turnId: 'turn-1', attemptId: 'attempt-1',
    })

    expect(completed.sides.left.messages.at(-1)).toMatchObject({ content: 'Refunds take five days.', state: 'completed' })
  })

  it('keeps the streamed reply when a completion carries no stored answer', () => {
    const active = beginTestExecutionTurn(state(), 'Refunds?', 'turn-1', 'attempt-1')
    const streamed = reduceTestExecutionEvent(active, {
      type: 'message_delta', executionId: 'execution-1', generation: 2, sideId: 'left', delta: 'Refunds take five days.', turnId: 'turn-1', attemptId: 'attempt-1',
    })

    const completed = reduceTestExecutionEvent(streamed, {
      type: 'side_completed', executionId: 'execution-1', generation: 2, sideId: 'left', messageId: 'message-left', turnId: 'turn-1', attemptId: 'attempt-1',
    })

    expect(completed.sides.left.messages.at(-1)).toMatchObject({ content: 'Refunds take five days.', state: 'completed' })
  })

  it('replaces a half-streamed reply with the failure when the side fails, as the reopened session shows it', () => {
    const active = beginTestExecutionTurn(state(), 'Refunds?', 'turn-1', 'attempt-1')
    const streamed = reduceTestExecutionEvent(active, {
      type: 'message_delta', executionId: 'execution-1', generation: 2, sideId: 'left', delta: 'Refunds take', turnId: 'turn-1', attemptId: 'attempt-1',
    })

    const failed = reduceTestExecutionEvent(streamed, {
      type: 'side_failed', executionId: 'execution-1', generation: 2, sideId: 'left', code: 'runner_failed', retryable: true, turnId: 'turn-1', attemptId: 'attempt-1',
    })

    expect(failed.sides.left.messages.at(-1)).toMatchObject({ content: 'Test failed: runner_failed', state: 'failed' })
    expect(failed.sides.left).toMatchObject({ state: 'failed', errorCode: 'runner_failed', retryable: true })
  })

  it('replaces a half-streamed reply with the stream-ended notice when the transport closes mid-answer', () => {
    const active = beginTestExecutionTurn(state(), 'Refunds?', 'turn-1', 'attempt-1')
    const streamed = reduceTestExecutionEvent(active, {
      type: 'message_delta', executionId: 'execution-1', generation: 2, sideId: 'left', delta: 'Refunds take', turnId: 'turn-1', attemptId: 'attempt-1',
    })

    const finalized = finalizeTestExecutionStream(streamed, 'stream_ended_before_terminal_event')

    expect(finalized.sides.left.messages.at(-1)).toMatchObject({ content: 'The response stream ended before an answer was complete.', state: 'failed' })
    expect(finalized.sides.left).toMatchObject({ state: 'failed', errorCode: 'stream_ended_before_terminal_event' })
  })

  it('replaces the failed assistant attempt when retrying while preserving the user and successful side', () => {
    const withTurn = beginTestExecutionTurn(state(), 'Hello', 'turn-1', 'attempt-1')
    const failed = failTestExecutionSide(withTurn, 'right', 'stream_transport_failed')
    const retrying = beginTestExecutionRetry(failed, 'right', 'attempt-2')

    expect(retrying.sides.right.retryable).toBe(false)
    expect(retrying.sides.right.messages.at(-1)).toMatchObject({ role: 'assistant', turnId: 'turn-1', attemptId: 'attempt-2', state: 'streaming' })
    expect(retrying.sides.right.messages).toHaveLength(2)
    expect(retrying.sides.right.messages[0]).toMatchObject({ role: 'user', content: 'Hello' })
    expect(retrying.sides.left.messages).toEqual(withTurn.sides.left.messages)
  })

  it('hydrates a saved in-progress attempt without inventing a terminal reply', () => {
    const reopened = hydrateTestExecutionState({
      id: 'execution-1', generation: 2, mode: 'single', skillEffects: 'suppressed', state: 'running', createdAt: '', testValues: [], seededTurnCount: 0,
      sides: [{ id: 'left', revision: { id: 'revision-7', label: 'Published', kind: 'published', versionNumber: 7, createdAt: '' }, conversationId: 'left-chat', state: 'running', retryable: false, history: [{ turnId: 'turn-1', role: 'user', content: 'Hello', attemptId: 'attempt-1', createdAt: '' }] }],
      attempts: [{ sideId: 'left', turnId: 'turn-1', attemptId: 'attempt-1', fence: 4, state: 'running', createdAt: '', updatedAt: '' }],
    })

    expect(reopened.activeTurnId).toBe('turn-1')
    expect(reopened.activeAttemptId).toBe('attempt-1')
    expect(reopened.sides.left.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Hello' }),
      expect.objectContaining({ role: 'assistant', state: 'streaming', content: '' }),
    ])
  })

  it('keeps a turn said on a Test Chat call marked spoken, and a typed one unmarked', () => {
    const reopened = hydrateTestExecutionState({
      id: 'execution-1', generation: 2, mode: 'single', skillEffects: 'suppressed', state: 'completed', createdAt: '', testValues: [], seededTurnCount: 0,
      sides: [{
        id: 'left', revision: { id: 'revision-8', label: 'Draft', kind: 'candidate', versionNumber: null, createdAt: '' }, conversationId: 'left-chat', state: 'completed', retryable: false,
        history: [
          { turnId: 'turn-1', role: 'user', content: 'Typed', attemptId: 'attempt-1', createdAt: '' },
          { turnId: 'turn-1', role: 'assistant', content: 'Typed answer', messageId: 'message-1', attemptId: 'attempt-1', createdAt: '' },
          { turnId: 'turn-2', role: 'user', content: 'Said', attemptId: 'attempt-2', createdAt: '', spoken: true },
          { turnId: 'turn-2', role: 'assistant', content: 'Spoken answer', messageId: 'message-2', attemptId: 'attempt-2', createdAt: '', spoken: true },
        ],
      }],
      attempts: [],
    })

    expect(reopened.sides.left.messages.map((message) => [message.content, message.spoken ?? false])).toEqual([
      ['Typed', false], ['Typed answer', false], ['Said', true], ['Spoken answer', true],
    ])
  })

  it('projects a missing failed assistant placeholder for the exact later turn so retry stays pinned', () => {
    const reopened = hydrateTestExecutionState({
      id: 'execution-1', generation: 2, mode: 'compare', skillEffects: 'suppressed', state: 'partial', createdAt: '', testValues: [], seededTurnCount: 0,
      sides: [
        { id: 'left', revision: { id: 'revision-7', label: 'Published', kind: 'published', versionNumber: 7, createdAt: '' }, conversationId: 'left-chat', state: 'completed', retryable: false, history: [{ turnId: 'turn-1', role: 'user', content: 'First', attemptId: 'attempt-1', createdAt: '' }, { turnId: 'turn-1', role: 'assistant', content: 'Done', attemptId: 'attempt-1', createdAt: '' }, { turnId: 'turn-2', role: 'user', content: 'Second', attemptId: 'attempt-2', createdAt: '' }] },
        { id: 'right', revision: { id: 'revision-8', label: 'Draft', kind: 'candidate', versionNumber: null, createdAt: '' }, conversationId: 'right-chat', state: 'failed', retryable: true, history: [{ turnId: 'turn-1', role: 'user', content: 'First', attemptId: 'attempt-1', createdAt: '' }, { turnId: 'turn-1', role: 'assistant', content: 'Done', attemptId: 'attempt-1', createdAt: '' }, { turnId: 'turn-2', role: 'user', content: 'Second', attemptId: 'attempt-2', createdAt: '' }] },
      ],
      attempts: [{ sideId: 'left', turnId: 'turn-2', attemptId: 'attempt-2', fence: 2, state: 'completed', createdAt: '', updatedAt: '' }, { sideId: 'right', turnId: 'turn-2', attemptId: 'attempt-2', fence: 2, state: 'failed', failureCode: 'provider_unavailable', createdAt: '', updatedAt: '' }],
    })

    expect(reopened.sides.right.messages.at(-1)).toMatchObject({ role: 'assistant', turnId: 'turn-2', attemptId: 'attempt-2', state: 'failed' })
    const retrying = beginTestExecutionRetry(reopened, 'right', 'attempt-3')
    expect(retrying.activeTurnId).toBe('turn-2')
    expect(retrying.sides.left.messages).toEqual(reopened.sides.left.messages)
  })

  it('keeps a failed turn a later message superseded in its place when the session is reopened', () => {
    const revision = { id: 'revision-7', label: 'Published', kind: 'published' as const, versionNumber: 7, createdAt: '' }
    const reopened = hydrateTestExecutionState({
      id: 'execution-1', generation: 2, mode: 'single', skillEffects: 'suppressed', state: 'completed', createdAt: '', testValues: [], seededTurnCount: 0,
      sides: [{
        id: 'left', revision, conversationId: 'left-chat', state: 'completed', retryable: false,
        history: [
          { turnId: 'turn-1', role: 'user', content: 'How do I contact a human?', attemptId: 'attempt-1', createdAt: '' },
          { turnId: 'turn-2', role: 'user', content: 'guest@example.com', attemptId: 'attempt-2', createdAt: '' },
          { turnId: 'turn-2', role: 'assistant', content: 'What would you like to tell them?', messageId: 'message-2', attemptId: 'attempt-2', createdAt: '' },
        ],
      }],
      // Turn 1 failed, and so did its retry (fence 2); turn 2 then started at fence 1 and completed.
      attempts: [
        { sideId: 'left', turnId: 'turn-1', attemptId: 'attempt-1', fence: 1, state: 'failed', failureCode: 'runner_failed', createdAt: '', updatedAt: '' },
        { sideId: 'left', turnId: 'turn-1', attemptId: 'attempt-1-retry', fence: 2, state: 'failed', failureCode: 'runner_failed', createdAt: '', updatedAt: '' },
        { sideId: 'left', turnId: 'turn-2', attemptId: 'attempt-2', fence: 1, state: 'completed', createdAt: '', updatedAt: '' },
      ],
    })

    expect(reopened.sides.left.messages).toEqual([
      expect.objectContaining({ role: 'user', turnId: 'turn-1', content: 'How do I contact a human?' }),
      expect.objectContaining({ role: 'assistant', turnId: 'turn-1', attemptId: 'attempt-1-retry', state: 'failed', content: 'Test failed: runner_failed' }),
      expect.objectContaining({ role: 'user', turnId: 'turn-2', content: 'guest@example.com' }),
      expect.objectContaining({ role: 'assistant', turnId: 'turn-2', state: 'completed', content: 'What would you like to tell them?' }),
    ])
    expect(reopened).toMatchObject({ activeTurnId: null, activeAttemptId: null })
    expect(reopened.sides.left).toMatchObject({ retryable: false, errorCode: undefined })
  })

  describe('initializeTestExecutionState status derivation', () => {
    const execution = (sides: Array<{ id: string; state: 'running' | 'failed' | 'completed' | 'missing' }>) => ({
      id: 'execution-1',
      generation: 2,
      mode: 'compare' as const,
      skillEffects: 'suppressed' as const,
      sides: sides.map(({ id, state: sideState }) => ({
        id,
        revision: { id: `revision-${id}`, label: id, kind: 'candidate' as const, versionNumber: null, createdAt: '' },
        conversationId: `${id}-chat`,
        state: sideState,
        retryable: sideState === 'failed',
      })),
    })

    it('is running while any side is still running', () => {
      const initial = initializeTestExecutionState(execution([{ id: 'left', state: 'running' }, { id: 'right', state: 'completed' }]))
      expect(initial.state).toBe('running')
    })

    it('is partial, not failed, when one side fails and none are running', () => {
      const initial = initializeTestExecutionState(execution([{ id: 'left', state: 'completed' }, { id: 'right', state: 'failed' }]))
      expect(initial.state).toBe('partial')
    })

    it('is partial even when every side has failed, matching the mid-stream finalizer', () => {
      const initial = initializeTestExecutionState(execution([{ id: 'left', state: 'failed' }, { id: 'right', state: 'failed' }]))
      expect(initial.state).toBe('partial')
    })

    it('is completed when every side is completed', () => {
      const initial = initializeTestExecutionState(execution([{ id: 'left', state: 'completed' }, { id: 'right', state: 'completed' }]))
      expect(initial.state).toBe('completed')
    })

    it('agrees with finalizeTestExecutionStream: a completed/failed side mix is partial everywhere, not just mid-stream', () => {
      const mixed = {
        executionId: 'execution-1',
        generation: 2,
        state: 'running' as const,
        activeTurnId: 'turn-1',
        activeAttemptId: 'attempt-1',
        sides: {
          left: { id: 'left', revisionId: 'revision-left', state: 'completed' as const, retryable: false, messages: [] },
          right: { id: 'right', revisionId: 'revision-right', state: 'running' as const, retryable: false, messages: [] },
        },
      }
      const initial = initializeTestExecutionState(execution([{ id: 'left', state: 'completed' }, { id: 'right', state: 'failed' }]))
      const streamed = finalizeTestExecutionStream(mixed, 'stream_transport_failed')
      expect(initial.state).toBe('partial')
      expect(streamed.state).toBe('partial')
    })
  })
})
