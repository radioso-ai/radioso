import { describe, expect, it } from 'vitest'

import type { AgentMechanicsReplies, AgentVoiceSettings } from '@/lib/api-types'
import { emptyVoiceLanguageLines, voiceSettingsFormFromAgent, voiceSettingsUpdateFromForm } from '@/lib/voice-settings-form'

const voice: AgentVoiceSettings = {
  enabled: true,
  bridgeLines: {
    en: { acknowledge: ['Thanks, I have noted that, so let me take the next step.'], check: ['Let me check that for you, it only takes a moment.'] },
  },
  fallbackLine: {
    en: 'Sorry, this is taking much longer than it should, could you ask me again?',
    it: 'Scusa, ci sto mettendo troppo, puoi ripetere la domanda per favore?',
  },
}
const mechanicsReplies: AgentMechanicsReplies = {
  'pt-BR': { greeting: ['Olá! Como posso ajudar?'], thanks: [], farewell: [], acknowledgement: [] },
  en: { greeting: ['Hi! How can I help?'], thanks: ['You are welcome!'], farewell: [], acknowledgement: [] },
}

describe('voice settings form', () => {
  it('reads both blocks into one entry per language, in the order languages first appear', () => {
    const form = voiceSettingsFormFromAgent(voice, mechanicsReplies)

    expect(form.enabled).toBe(true)
    expect(form.languages.map((language) => language.locale)).toEqual(['en', 'it', 'pt-BR'])
    expect(form.languages[0]).toEqual({
      locale: 'en',
      bridgeLines: voice.bridgeLines.en,
      fallbackLine: voice.fallbackLine.en,
      mechanicsReplies: mechanicsReplies.en,
    })
    // A language one block lacks reads as empty there, not as missing.
    expect(form.languages[1]).toEqual({ ...emptyVoiceLanguageLines('it'), fallbackLine: voice.fallbackLine.it })
  })

  it('writes the same blocks back when nothing was edited', () => {
    expect(voiceSettingsUpdateFromForm(voiceSettingsFormFromAgent(voice, mechanicsReplies))).toEqual({ voice, mechanicsReplies })
  })

  it('trims lines, drops blank ones, and leaves a language out of a block it has nothing in', () => {
    const update = voiceSettingsUpdateFromForm({
      enabled: false,
      languages: [
        {
          locale: 'en',
          bridgeLines: { check: ['  Let me check that for you, it only takes a moment.  ', '   '], acknowledge: [''] },
          fallbackLine: '  ',
          mechanicsReplies: { greeting: [' Hi! '], thanks: [], farewell: [''], acknowledgement: [] },
        },
        { ...emptyVoiceLanguageLines('it'), fallbackLine: 'Scusa, ci sto mettendo troppo.' },
        emptyVoiceLanguageLines('de'),
      ],
    })

    expect(update).toEqual({
      voice: {
        enabled: false,
        bridgeLines: { en: { acknowledge: [], check: ['Let me check that for you, it only takes a moment.'] } },
        fallbackLine: { it: 'Scusa, ci sto mettendo troppo.' },
      },
      mechanicsReplies: { en: { greeting: ['Hi!'], thanks: [], farewell: [], acknowledgement: [] } },
    })
  })

  it('reads an agent with nothing authored as voice off and no languages', () => {
    expect(voiceSettingsFormFromAgent({ enabled: false, bridgeLines: {}, fallbackLine: {} }, {})).toEqual({ enabled: false, languages: [] })
  })
})
