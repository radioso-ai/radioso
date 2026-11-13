import { describe, expect, it } from 'vitest'

import { streamChatEvents } from '@/lib/api-chat-stream'
import type { ChatStreamBlock, ChatStreamCompletion, ReplyBlock } from '@/lib/api-types'

const carousel = (id: string): ReplyBlock => ({
  type: 'item_list',
  id,
  layout: 'carousel',
  selection: 'none',
  caption: 'Hiking guides in stock',
  items: [{
    key: 'item-1',
    title: 'Ridge Walks of the North',
    image: {
      src: 'https://app.example/backend/api/v1/public/reply-images/image-1/640',
      srcSet: 'https://app.example/backend/api/v1/public/reply-images/image-1/320 320w, https://app.example/backend/api/v1/public/reply-images/image-1/640 640w',
      alt: 'Cover of Ridge Walks of the North',
      width: 640,
      height: 960,
    },
    actions: [{ type: 'open', url: 'https://shop.example/books/ridge-walks' }],
  }],
})

const sse = (events: Array<[string, unknown]>) =>
  new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })

describe('streamChatEvents', () => {
  it('preserves ownership acknowledgements from done events', async () => {
    const completion = {
      type: 'done',
      conversationId: 'conversation-1',
      assistantMessageId: '',
      answer: '',
      ownership: {
        state: 'human_owned',
        suppressed: true,
      },
    }
    const response = new Response(`event: done\ndata: ${JSON.stringify(completion)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
    let donePayload: ChatStreamCompletion | undefined

    const result = await streamChatEvents(response, {
      onDone: (payload) => {
        donePayload = payload
      },
    })

    expect(donePayload?.ownership).toEqual(completion.ownership)
    expect(result.ownership).toEqual(completion.ownership)
  })

  it('dispatches typed cancelled events', async () => {
    const cancelled = {
      conversationId: 'conversation-1',
      reason: 'superseded',
      stage: 'routing',
    }
    const response = new Response(`event: cancelled\ndata: ${JSON.stringify(cancelled)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
    let cancelledPayload: typeof cancelled | undefined

    const result = await streamChatEvents(response, {
      onCancelled: (payload) => {
        cancelledPayload = payload
      },
    })

    expect(cancelledPayload).toEqual(cancelled)
    expect(result).toMatchObject({ conversationId: 'conversation-1', answer: '' })
  })

  it('retains coverage debug from the terminal SSE event in the awaited response', async () => {
    const completion = {
      type: 'done',
      conversationId: 'conversation-1',
      answer: 'A grounded answer.',
      debug: {
        answerCoverage: {
          availability: 'assessed', coverage: 'partial', reason: 'insufficient_evidence',
          contextualizedRequest: 'Can I attend?', originatingTurnId: 'turn-1', originatingRequestId: 'request-1', schemaVersion: 1,
        },
        interactionTrace: { state: 'evaluated', decisions: [] },
      },
    }
    const response = new Response(`event: done\ndata: ${JSON.stringify(completion)}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })

    const result = await streamChatEvents(response, {})

    expect(result.debug).toEqual(completion.debug)
  })

  it('hands each reply block over as it arrives and keeps them for the completion', async () => {
    const block = carousel('block-1')
    const blocks: Array<ChatStreamBlock & { blocks: ReplyBlock[] }> = []
    let donePayload: ChatStreamCompletion | undefined

    const result = await streamChatEvents(sse([
      ['chunk', { text: 'Here are two guides.' }],
      ['block', { conversationId: 'conversation-1', assistantMessageId: 'assistant-1', block }],
      ['done', { conversationId: 'conversation-1', assistantMessageId: 'assistant-1', answer: 'Here are two guides.' }],
    ]), {
      onBlock: (payload) => blocks.push(payload),
      onDone: (payload) => {
        donePayload = payload
      },
    })

    expect(blocks).toEqual([{ conversationId: 'conversation-1', assistantMessageId: 'assistant-1', block, blocks: [block] }])
    expect(donePayload?.blocks).toEqual([block])
    expect(result.blocks).toEqual([block])
  })

  it('takes the blocks the done event repeats over the ones streamed before it', async () => {
    const streamed = carousel('block-1')
    const final = carousel('block-2')

    const result = await streamChatEvents(sse([
      ['block', { block: streamed }],
      ['done', { conversationId: 'conversation-1', answer: 'Here they are.', blocks: [final] }],
    ]), {})

    expect(result.blocks).toEqual([final])
  })

  it('keeps one block per id when the stream sends a block again, in the place it first took', async () => {
    const first = carousel('block-1')
    const second = carousel('block-2')
    const revised = { ...first, caption: 'Hiking guides back in stock' }
    const shown: ReplyBlock[][] = []

    const result = await streamChatEvents(sse([
      ['block', { block: first }],
      ['block', { block: second }],
      ['block', { block: revised }],
      ['done', { conversationId: 'conversation-1', answer: 'Here they are.' }],
    ]), {
      onBlock: ({ blocks }) => shown.push(blocks),
    })

    expect(shown).toEqual([[first], [first, second], [revised, second]])
    expect(result.blocks).toEqual([revised, second])
  })

  it('takes the blocks from the done event when no block event came before it', async () => {
    const block = carousel('block-1')
    let streamedBlocks = 0
    let donePayload: ChatStreamCompletion | undefined

    const result = await streamChatEvents(sse([
      ['chunk', { text: 'Here is a guide.' }],
      ['done', { conversationId: 'conversation-1', answer: 'Here is a guide.', blocks: [block] }],
    ]), {
      onBlock: () => {
        streamedBlocks += 1
      },
      onDone: (payload) => {
        donePayload = payload
      },
    })

    expect(streamedBlocks).toBe(0)
    expect(donePayload?.blocks).toEqual([block])
    expect(result.blocks).toEqual([block])
  })

  it('leaves blocks out of an answer that has none', async () => {
    const result = await streamChatEvents(sse([
      ['done', { conversationId: 'conversation-1', answer: 'We open at nine.' }],
    ]), {})

    expect(result).not.toHaveProperty('blocks')
  })
})
