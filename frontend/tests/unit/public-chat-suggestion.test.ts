import { describe, expect, it } from 'vitest'

import { suggestionInputMetadata } from '@/lib/public-chat-suggestion'

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
