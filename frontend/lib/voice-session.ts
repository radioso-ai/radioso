/**
 * The visible life of one voice call from the chat panel, as a pure state machine. The panel
 * shows a Talk button until a call starts, a call bar while it is connecting or live, and one
 * terse line after it ends or fails. Nothing here touches the microphone, the network or a vendor;
 * `voice-call.ts` runs the call and reports what happened as these events.
 */

/** Why a call never got going: the microphone was refused or missing, or no session could be started. */
export type VoiceCallProblem = 'microphone' | 'unavailable'

/** Who spoke, as the vendor's agent turns the call into lines. */
export type VoiceMode = 'listening' | 'speaking'

export type VoiceSessionState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'live'; mode: VoiceMode }
  | { status: 'ended' }
  | { status: 'failed'; problem: VoiceCallProblem }

export type VoiceSessionEvent =
  | { type: 'talk_pressed' }
  | { type: 'microphone_refused' }
  | { type: 'start_refused' }
  | { type: 'connected' }
  | { type: 'mode_changed'; mode: VoiceMode }
  | { type: 'stop_pressed' }
  | { type: 'disconnected' }

export const initialVoiceSessionState: VoiceSessionState = { status: 'idle' }

/** A call is under way from the press until it ends: the Talk button gives way to the call bar. */
export const isVoiceCallActive = (state: VoiceSessionState): boolean =>
  state.status === 'connecting' || state.status === 'live'

export function voiceSessionReducer(state: VoiceSessionState, event: VoiceSessionEvent): VoiceSessionState {
  switch (event.type) {
    case 'talk_pressed':
      return isVoiceCallActive(state) ? state : { status: 'connecting' }
    case 'microphone_refused':
      return state.status === 'connecting' ? { status: 'failed', problem: 'microphone' } : state
    case 'start_refused':
      return state.status === 'connecting' ? { status: 'failed', problem: 'unavailable' } : state
    case 'connected':
      return state.status === 'connecting' ? { status: 'live', mode: 'listening' } : state
    case 'mode_changed':
      // A vendor may report who is speaking before it reports the connection.
      return isVoiceCallActive(state) ? { status: 'live', mode: event.mode } : state
    case 'stop_pressed':
      return isVoiceCallActive(state) ? { status: 'ended' } : state
    case 'disconnected':
      // A call that drops before it connects never started; one that drops later ended.
      if (state.status === 'connecting') return { status: 'failed', problem: 'unavailable' }
      return state.status === 'live' ? { status: 'ended' } : state
  }
}

/** One line of what was said on the call, as the vendor reports it. */
export interface VoiceTranscriptLine {
  id: string
  speaker: 'caller' | 'agent'
  text: string
  /** The vendor's id for one agent reply; a reply it reports again replaces its line. */
  responseId?: string
  /** The chat message the line followed when it arrived, so it stays in place as the thread grows. */
  afterMessageId: string | null
}

export function appendVoiceTranscriptLine(
  lines: readonly VoiceTranscriptLine[],
  line: VoiceTranscriptLine,
): VoiceTranscriptLine[] {
  if (!line.text.trim()) return [...lines]
  if (line.responseId) {
    const index = lines.findIndex((existing) => existing.responseId === line.responseId)
    if (index >= 0) {
      return lines.map((existing, at) => (at === index ? { ...line, id: existing.id, afterMessageId: existing.afterMessageId } : existing))
    }
  }
  return [...lines, line]
}

/**
 * Places each transcript line right after the chat message it followed when it arrived, keeping
 * the order lines arrived in. A line whose message is gone from the thread goes at the end.
 */
export function interleaveVoiceTranscript<Message extends { id: string }, Line extends { afterMessageId: string | null }>(
  messages: readonly Message[],
  lines: readonly Line[],
): Array<Message | Line> {
  if (lines.length === 0) return [...messages]
  const knownIds = new Set(messages.map((message) => message.id))
  const linesAfter = new Map<string | null, Line[]>()
  const trailing: Line[] = []
  for (const line of lines) {
    if (line.afterMessageId !== null && !knownIds.has(line.afterMessageId)) {
      trailing.push(line)
      continue
    }
    const bucket = linesAfter.get(line.afterMessageId) ?? []
    bucket.push(line)
    linesAfter.set(line.afterMessageId, bucket)
  }
  const merged: Array<Message | Line> = [...(linesAfter.get(null) ?? [])]
  for (const message of messages) {
    merged.push(message, ...(linesAfter.get(message.id) ?? []))
  }
  return [...merged, ...trailing]
}
