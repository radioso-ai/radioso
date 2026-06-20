import { describe, expect, it } from 'vitest'

import { streamChatEvents } from '@/lib/api-chat-stream'
import type { ChatStreamCompletion } from '@/lib/api-types'

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
})
