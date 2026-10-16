import { describe, expect, it } from 'vitest'

import {
  appendVoiceTranscriptLine,
  initialVoiceSessionState,
  interleaveVoiceTranscript,
  isVoiceCallActive,
  voiceSessionReducer,
  type VoiceSessionEvent,
  type VoiceSessionState,
  type IncomingVoiceTranscriptLine,
} from '@/lib/voice-session'

const run = (events: VoiceSessionEvent[], from: VoiceSessionState = initialVoiceSessionState) =>
  events.reduce(voiceSessionReducer, from)

describe('voice session state', () => {
  it('connects, listens, speaks while the agent talks, and ends on Stop', () => {
    const connecting = run([{ type: 'talk_pressed' }])
    expect(connecting).toEqual({ status: 'connecting' })
    expect(isVoiceCallActive(connecting)).toBe(true)

    const listening = run([{ type: 'connected' }], connecting)
    expect(listening).toEqual({ status: 'live', mode: 'listening' })

    const speaking = run([{ type: 'mode_changed', mode: 'speaking' }], listening)
    expect(speaking).toEqual({ status: 'live', mode: 'speaking' })
    expect(run([{ type: 'mode_changed', mode: 'listening' }], speaking)).toEqual({ status: 'live', mode: 'listening' })

    const ended = run([{ type: 'stop_pressed' }], speaking)
    expect(ended).toEqual({ status: 'ended' })
    expect(isVoiceCallActive(ended)).toBe(false)
  })

  it('takes a call stopped before it connected back to Talk, with no notice', () => {
    expect(run([{ type: 'talk_pressed' }, { type: 'stop_pressed' }])).toEqual({ status: 'idle' })
  })

  it('ends a live call the vendor closed', () => {
    expect(run([{ type: 'talk_pressed' }, { type: 'connected' }, { type: 'disconnected' }])).toEqual({ status: 'ended' })
  })

  it('fails on a refused microphone, before any session start', () => {
    expect(run([{ type: 'talk_pressed' }, { type: 'microphone_refused' }])).toEqual({ status: 'failed', problem: 'microphone' })
  })

  it('fails as unavailable when no session could be started, or the vendor dropped it before connecting', () => {
    expect(run([{ type: 'talk_pressed' }, { type: 'start_refused' }])).toEqual({ status: 'failed', problem: 'unavailable' })
    expect(run([{ type: 'talk_pressed' }, { type: 'disconnected' }])).toEqual({ status: 'failed', problem: 'unavailable' })
  })

  it('takes a mode report that arrives before the connection report', () => {
    expect(run([{ type: 'talk_pressed' }, { type: 'mode_changed', mode: 'speaking' }])).toEqual({ status: 'live', mode: 'speaking' })
  })

  it('starts a new call after one ended or failed, and ignores a second press during a call', () => {
    expect(run([{ type: 'talk_pressed' }], { status: 'ended' })).toEqual({ status: 'connecting' })
    expect(run([{ type: 'talk_pressed' }], { status: 'failed', problem: 'microphone' })).toEqual({ status: 'connecting' })
    const live: VoiceSessionState = { status: 'live', mode: 'speaking' }
    expect(run([{ type: 'talk_pressed' }], live)).toBe(live)
  })

  it('ignores what a stopped call still reports', () => {
    const ended: VoiceSessionState = { status: 'ended' }
    for (const event of [
      { type: 'connected' },
      { type: 'mode_changed', mode: 'speaking' },
      { type: 'disconnected' },
      { type: 'start_refused' },
      { type: 'microphone_refused' },
      { type: 'stop_pressed' },
    ] satisfies VoiceSessionEvent[]) {
      expect(voiceSessionReducer(ended, event)).toBe(ended)
    }
  })
})

const line = (overrides: Partial<IncomingVoiceTranscriptLine>): IncomingVoiceTranscriptLine => ({
  id: 'voice-line-1',
  speaker: 'caller',
  text: 'Hello',
  afterMessageId: 'greeting',
  ...overrides,
})

describe('voice transcript lines', () => {
  it('appends lines in the order they arrive and hands back the same lines for a blank one', () => {
    const first = appendVoiceTranscriptLine([], line({ id: 'a', text: 'Do you open on Sunday?' }))
    const second = appendVoiceTranscriptLine(first, line({ id: 'b', speaker: 'agent', text: 'Yes, from ten.' }))
    expect(second.map((entry) => entry.text)).toEqual(['Do you open on Sunday?', 'Yes, from ten.'])
    expect(appendVoiceTranscriptLine(second, line({ id: 'c', text: '   ' }))).toBe(second)
  })

  it('shows what was spoken of a reply the caller talked over, in its place', () => {
    const lines = [
      line({ id: 'a', speaker: 'agent', text: 'We open at ten and close at four on Sundays.' }),
      line({ id: 'b', speaker: 'caller', text: 'Ten is fine.' }),
    ]

    const corrected = appendVoiceTranscriptLine(lines, line({
      id: 'c',
      speaker: 'agent',
      text: 'We open at ten',
      corrects: 'We open at ten and close at four on Sundays.',
      afterMessageId: 'later',
    }))

    expect(corrected).toEqual([{ ...lines[0], text: 'We open at ten' }, lines[1]])
  })

  it('corrects a reply by its vendor id when the vendor names one', () => {
    const lines = [line({ id: 'a', speaker: 'agent', text: 'We open at ten and close at four.', responseId: 'r1' })]

    const corrected = appendVoiceTranscriptLine(lines, line({ id: 'b', speaker: 'agent', text: 'We open', corrects: 'something else', responseId: 'r1' }))

    expect(corrected).toEqual([{ ...lines[0], text: 'We open' }])
  })

  it('removes a reply the caller talked over before any of it was spoken, and adds a correction it cannot place', () => {
    const lines = [line({ id: 'a', speaker: 'agent', text: 'We open at ten.' })]

    expect(appendVoiceTranscriptLine(lines, line({ id: 'b', speaker: 'agent', text: '', corrects: 'We open at ten.' }))).toEqual([])
    expect(appendVoiceTranscriptLine(lines, line({ id: 'c', speaker: 'agent', text: 'Hello', corrects: 'Hello there' }))).toEqual([
      lines[0],
      { id: 'c', speaker: 'agent', text: 'Hello', afterMessageId: 'greeting' },
    ])
  })

  it('replaces an agent reply the vendor reports again, keeping its place', () => {
    const lines = [
      line({ id: 'a', speaker: 'agent', text: 'We open at', responseId: 'r1' }),
      line({ id: 'b', speaker: 'caller', text: 'Thanks', afterMessageId: 'greeting' }),
    ]
    const replaced = appendVoiceTranscriptLine(lines, line({ id: 'c', speaker: 'agent', text: 'We open at ten.', responseId: 'r1', afterMessageId: 'later' }))
    expect(replaced).toEqual([
      { id: 'a', speaker: 'agent', text: 'We open at ten.', responseId: 'r1', afterMessageId: 'greeting' },
      lines[1],
    ])
  })

  it('places each line after the chat message it followed, and lines whose message is gone at the end', () => {
    const messages = [{ id: 'greeting' }, { id: 'question' }, { id: 'answer' }]
    const lines = [
      { id: 'v1', afterMessageId: 'question' },
      { id: 'v2', afterMessageId: 'question' },
      { id: 'v3', afterMessageId: 'cleared' },
      { id: 'v0', afterMessageId: null },
    ]
    expect(interleaveVoiceTranscript(messages, lines).map((entry) => entry.id)).toEqual(['v0', 'greeting', 'question', 'v1', 'v2', 'answer', 'v3'])
  })

  it('leaves the thread as it is when nothing was said', () => {
    const messages = [{ id: 'greeting' }]
    expect(interleaveVoiceTranscript(messages, [])).toEqual(messages)
  })
})
