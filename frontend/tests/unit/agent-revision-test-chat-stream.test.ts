import { describe, expect, it } from 'vitest'

import { parseEvents } from '@/components/dashboard/agent-revision-test-chat'
import { beginTestExecutionRetry, beginTestExecutionTurn, initializeTestExecutionState, reduceTestExecutionEvent, type TestExecutionState } from '@/lib/agent-test-execution-state'
import type { TestExecutionEvent } from '@/lib/api-agent-revisions'

const EXECUTION = 'execution-1'
const SIDE = 'side-1'
const TURN = 'turn-1'
const ATTEMPT = 'attempt-1'

const ANSWER = [
  'Yes — you can return it if it was delivered within the last 30 days, and an unused kettle in its original packaging meets the return condition.',
  '',
  'For the return label, the fee depends on why you’re returning it: return shipping is free for defective items, otherwise €4.95 is deducted. Refunds land in 5–7 business days 👍.',
].join('\n')

// A seeded PRNG keeps the arbitrary cut points reproducible.
const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

/** Splits by UTF-16 code unit without breaking surrogate pairs, into 2–10 char deltas like the backend sends. */
const toDeltas = (text: string, random: () => number): string[] => {
  const chars = Array.from(text)
  const deltas: string[] = []
  for (let index = 0; index < chars.length;) {
    const size = 2 + Math.floor(random() * 9)
    deltas.push(chars.slice(index, index + size).join(''))
    index += size
  }
  return deltas
}

const base = { executionId: EXECUTION, generation: 1, turnId: TURN, attemptId: ATTEMPT }

/** Exactly the backend presenter's framing, keepalive comments included. */
const frame = (event: TestExecutionEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

const sseText = (deltas: string[], attemptId = ATTEMPT) => {
  const ids = { ...base, attemptId }
  const parts: string[] = [frame({ type: 'side_started', ...ids, sideId: SIDE })]
  deltas.forEach((delta, index) => {
    if (index % 7 === 3) parts.push(': keepalive\n\n')
    parts.push(frame({ type: 'message_delta', ...ids, sideId: SIDE, delta }))
  })
  parts.push(frame({ type: 'side_completed', ...ids, sideId: SIDE, messageId: 'message-1', answer: deltas.join('') }))
  parts.push(frame({ type: 'execution_completed', ...ids }))
  return parts.join('')
}

const responseFromChunks = (chunks: Uint8Array[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    chunks.forEach((chunk) => controller.enqueue(chunk))
    controller.close()
  },
}))

const cut = (bytes: Uint8Array, offsets: number[]) => {
  const sorted = [...new Set(offsets)].filter((offset) => offset > 0 && offset < bytes.length).sort((a, b) => a - b)
  const bounds = [0, ...sorted, bytes.length]
  return bounds.slice(1).map((end, index) => bytes.slice(bounds[index], end))
}

/** Byte offsets that land strictly inside a multi-byte UTF-8 sequence, or between the two `\n` of a frame end. */
const awkwardOffsets = (bytes: Uint8Array) => {
  const offsets: number[] = []
  bytes.forEach((byte, index) => {
    if ((byte & 0b1100_0000) === 0b1000_0000) offsets.push(index)
    if (byte === 0x0a && bytes[index + 1] === 0x0a) offsets.push(index + 1)
  })
  return offsets
}

const initialState = (): TestExecutionState => beginTestExecutionTurn(initializeTestExecutionState({
  id: EXECUTION,
  generation: 1,
  mode: 'single',
  skillEffects: 'suppressed',
  sides: [{ id: SIDE, revision: { id: 'revision-1', label: 'v1', kind: 'published', versionNumber: 1, createdAt: '' }, conversationId: 'conversation-1', state: 'running', retryable: false }],
}), 'Can I return the kettle?', TURN, ATTEMPT)

const assistantContent = (state: TestExecutionState) => state.sides[SIDE].messages.at(-1)?.content ?? ''

/** Drives the parser into the reducer, recording the rendered content after every event. */
const run = async (response: Response, start: TestExecutionState = initialState()) => {
  let state = start
  const events: TestExecutionEvent[] = []
  const contents: string[] = []
  const sawTerminal = await parseEvents(response, (event) => {
    events.push(event)
    state = reduceTestExecutionEvent(state, event)
    contents.push(assistantContent(state))
  })
  return { state, events, contents, sawTerminal }
}

const expectCleanStream = (result: Awaited<ReturnType<typeof run>>, deltas: string[]) => {
  const received = result.events.filter((event) => event.type === 'message_delta').map((event) => event.delta)
  expect(received).toEqual(deltas)
  // Every intermediate render is a prefix of the answer: no delta is ever applied twice.
  result.contents.forEach((content) => expect(ANSWER.startsWith(content)).toBe(true))
  expect(assistantContent(result.state)).toBe(ANSWER)
  expect(result.sawTerminal).toBe(true)
}

describe('test chat stream consumer', () => {
  it('accumulates exactly the concatenated deltas when every byte arrives in its own read', async () => {
    const deltas = toDeltas(ANSWER, prng(1))
    const bytes = new TextEncoder().encode(sseText(deltas))
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte))

    expectCleanStream(await run(responseFromChunks(chunks)), deltas)
  })

  it('accumulates exactly the concatenated deltas when reads split frames and multi-byte characters', async () => {
    const deltas = toDeltas(ANSWER, prng(2))
    const bytes = new TextEncoder().encode(sseText(deltas))

    expectCleanStream(await run(responseFromChunks(cut(bytes, awkwardOffsets(bytes)))), deltas)
  })

  it.each(Array.from({ length: 50 }, (_, seed) => seed + 10))('accumulates exactly the concatenated deltas at seeded random read boundaries (seed %i)', async (seed) => {
    const random = prng(seed)
    const deltas = toDeltas(ANSWER, random)
    const bytes = new TextEncoder().encode(sseText(deltas))
    const offsets = Array.from({ length: 1 + Math.floor(random() * 120) }, () => Math.floor(random() * bytes.length))

    expectCleanStream(await run(responseFromChunks(cut(bytes, offsets))), deltas)
  })

  it('starts a retried side from empty text, so the replayed deltas are not appended to the failed attempt', async () => {
    const deltas = toDeltas(ANSWER, prng(3))
    const firstAttempt = await run(responseFromChunks([new TextEncoder().encode(
      frame({ type: 'side_started', ...base, sideId: SIDE })
        + deltas.slice(0, 5).map((delta) => frame({ type: 'message_delta', ...base, sideId: SIDE, delta })).join('')
        + frame({ type: 'side_failed', ...base, sideId: SIDE, code: 'runner_failed', retryable: true }),
    )]))
    const retried = beginTestExecutionRetry(firstAttempt.state, SIDE, 'attempt-2')
    const bytes = new TextEncoder().encode(sseText(deltas, 'attempt-2'))

    expectCleanStream(await run(responseFromChunks(cut(bytes, awkwardOffsets(bytes))), retried), deltas)
  })
})
