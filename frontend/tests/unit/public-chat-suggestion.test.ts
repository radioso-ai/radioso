import { describe, expect, it } from 'vitest'

import { actionableSuggestionsOnly, suggestionInputMetadata } from '@/lib/public-chat-suggestion'

const MESSAGE_ID = '6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5'

describe('suggestionInputMetadata', () => {
  it('sends a chip with an id as a click naming that chip and the message it came with', () => {
    expect(suggestionInputMetadata({ id: 'agree', text: 'I agree', kind: 'authored', action: { kind: 'ask_followup' } }, MESSAGE_ID))
      .toEqual({ method: 'suggestion_click', suggestionSourceMessageId: MESSAGE_ID, suggestionId: 'agree' })
  })

  it('sends a generated follow-up, which has no id, as a click on its message alone', () => {
    expect(suggestionInputMetadata({ text: 'What about refunds?', kind: 'deeper' }, MESSAGE_ID))
      .toEqual({ method: 'suggestion_click', suggestionSourceMessageId: MESSAGE_ID })
  })

  it('sends a chip that starts an intent as the intent', () => {
    const intent = { skillName: 'contact', intentName: 'talk_to_human' }
    expect(suggestionInputMetadata({ id: 'contact', text: 'Talk to a person', kind: 'authored', action: { kind: 'start_intent', intent } }, MESSAGE_ID))
      .toEqual({ method: 'intent_click', intent, suggestionSourceMessageId: MESSAGE_ID })
  })
})

describe('actionableSuggestionsOnly', () => {
  const consent = [
    { id: 'agree', text: 'I agree', kind: 'authored' as const },
    { id: 'decline', text: 'No thanks', kind: 'authored' as const },
  ]
  const followUps = [{ text: 'What about refunds?', kind: 'deeper' as const }]
  const chipsByMessage = (messages: Array<{ id: string; suggestions?: unknown[] }>) =>
    Object.fromEntries(messages.map((message) => [message.id, message.suggestions?.length ?? 0]))

  it('drops the chips of a message the visitor has already answered, as the live thread does', () => {
    const restored = actionableSuggestionsOnly([
      { id: 'greeting', role: 'assistant', suggestions: followUps },
      { id: 'ask', role: 'user' },
      { id: 'consent', role: 'assistant', suggestions: consent },
      { id: 'agreed', role: 'user' },
      { id: 'next-step', role: 'assistant' },
    ])
    expect(chipsByMessage(restored)).toEqual({ greeting: 0, ask: 0, consent: 0, agreed: 0, 'next-step': 0 })
  })

  it('keeps the chips of the newest message while it is the agent\'s and still unanswered', () => {
    const restored = actionableSuggestionsOnly([
      { id: 'greeting', role: 'assistant', suggestions: followUps },
      { id: 'ask', role: 'user' },
      { id: 'consent', role: 'assistant', suggestions: consent },
    ])
    expect(chipsByMessage(restored)).toEqual({ greeting: 0, ask: 0, consent: 2 })
    expect(restored.at(-1)?.suggestions).toBe(consent)
  })

  it('keeps an unanswered greeting\'s chips', () => {
    expect(chipsByMessage(actionableSuggestionsOnly([{ id: 'greeting', role: 'assistant', suggestions: followUps }])))
      .toEqual({ greeting: 1 })
  })

  it('leaves a message without chips as it was', () => {
    const answered = { id: 'ask', role: 'user' as const }
    expect(actionableSuggestionsOnly([answered])[0]).toBe(answered)
  })
})
