import { describe, expect, it } from 'vitest'

import type { AgentMechanicsReplies, AgentVoiceSettings } from '@/lib/api-types'
import {
  ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS,
  MECHANICS_REPLY_KINDS,
  VOICE_BRIDGE_STYLES,
  emptyVoiceLanguageLines,
  isBelowElevenLabsSpokenFloor,
  voiceSettingsFormAfterSave,
  voiceSettingsFormFromAgent,
  voiceSettingsUpdateFromForm,
} from '@/lib/voice-settings-form'

const voice: AgentVoiceSettings = {
  enabled: true,
  bridgeLines: {
    en: { acknowledge: ['Thanks, I have noted that, so let me take the next step.'], check: ['Let me check that for you, it only takes a moment.'] },
  },
  fallbackLine: {
    en: 'Sorry, this is taking much longer than it should, could you ask me again?',
    it: 'Scusa, ci sto mettendo troppo, puoi ripetere la domanda per favore?',
  },
  runtime: { vendor: 'elevenlabs', agentId: 'agent_01jxk2v9qbe8n7r6t5w4' },
}
const unbound = { vendor: 'elevenlabs', agentId: '' } as const
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
      runtime: unbound,
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
        runtime: null,
      },
      mechanicsReplies: { en: { greeting: ['Hi!'], thanks: [], farewell: [], acknowledgement: [] } },
    })
  })

  it('reads an agent with nothing authored as voice off and no languages', () => {
    expect(voiceSettingsFormFromAgent({ enabled: false, bridgeLines: {}, fallbackLine: {}, runtime: null }, {}))
      .toEqual({ enabled: false, runtime: unbound, languages: [] })
  })

  it('writes every bridge style and every reply kind the form knows', () => {
    const language = emptyVoiceLanguageLines('en')
    for (const style of VOICE_BRIDGE_STYLES) language.bridgeLines[style] = [`A ${style} line.`]
    for (const kind of MECHANICS_REPLY_KINDS) language.mechanicsReplies[kind] = [`A ${kind} line.`]

    const update = voiceSettingsUpdateFromForm({ enabled: true, runtime: unbound, languages: [language] })

    expect(Object.keys(update.voice.bridgeLines.en).sort()).toEqual([...VOICE_BRIDGE_STYLES].sort())
    expect(Object.keys(update.mechanicsReplies.en).sort()).toEqual([...MECHANICS_REPLY_KINDS].sort())
  })

  it('keeps a language with nothing in it across a save, in the order the operator added it', () => {
    const form = {
      enabled: true,
      runtime: unbound,
      languages: [
        { ...emptyVoiceLanguageLines('en'), bridgeLines: { check: ['  Let me check that for you, it only takes a moment. ', ''], acknowledge: [] } },
        emptyVoiceLanguageLines('it'),
      ],
    }
    const saved = voiceSettingsUpdateFromForm(form)

    const after = voiceSettingsFormAfterSave(form, saved.voice, saved.mechanicsReplies)

    expect(after.languages.map((language) => language.locale)).toEqual(['en', 'it'])
    // Lines come back as the server stored them: trimmed, blanks dropped.
    expect(after.languages[0].bridgeLines.check).toEqual(['Let me check that for you, it only takes a moment.'])
    expect(after.languages[1]).toEqual(emptyVoiceLanguageLines('it'))
  })

  it('takes enabled and every line from the server after a save, adding any language only the server has', () => {
    const after = voiceSettingsFormAfterSave({ enabled: true, runtime: unbound, languages: [emptyVoiceLanguageLines('it')] }, voice, mechanicsReplies)

    expect(after.enabled).toBe(true)
    expect(after.runtime).toEqual(voice.runtime)
    expect(after.languages.map((language) => language.locale)).toEqual(['it', 'en', 'pt-BR'])
    expect(after.languages[0].fallbackLine).toBe(voice.fallbackLine.it)
  })

  it('reads the bound vendor agent into the form', () => {
    expect(voiceSettingsFormFromAgent(voice, mechanicsReplies).runtime).toEqual({ vendor: 'elevenlabs', agentId: 'agent_01jxk2v9qbe8n7r6t5w4' })
  })

  it('binds the trimmed vendor agent id, and binds none when the id is blank', () => {
    const form = voiceSettingsFormFromAgent(voice, mechanicsReplies)

    expect(voiceSettingsUpdateFromForm({ ...form, runtime: { vendor: 'elevenlabs', agentId: '  agent_42  ' } }).voice.runtime)
      .toEqual({ vendor: 'elevenlabs', agentId: 'agent_42' })
    expect(voiceSettingsUpdateFromForm({ ...form, runtime: { vendor: 'elevenlabs', agentId: '   ' } }).voice.runtime).toBeNull()
  })

  it('flags a line shorter than the ElevenLabs first-sentence floor, counting characters rather than code units', () => {
    expect(ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS).toBe(45)
    expect(isBelowElevenLabsSpokenFloor('One moment.')).toBe(true)
    expect(isBelowElevenLabsSpokenFloor('Let me check that for you, it only takes a moment.')).toBe(false)
    expect(isBelowElevenLabsSpokenFloor(`  ${'a'.repeat(45)}  `)).toBe(false)
    expect(isBelowElevenLabsSpokenFloor('😀'.repeat(44))).toBe(true)
    // Nothing written yet is not a short line.
    expect(isBelowElevenLabsSpokenFloor('   ')).toBe(false)
  })
})
