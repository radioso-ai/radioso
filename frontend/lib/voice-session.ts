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
  /** The vendor failed the call, or did not answer its handshake in time. */
  | { type: 'call_failed' }
  | { type: 'connected' }
  | { type: 'mode_changed'; mode: VoiceMode }
  | { type: 'stop_pressed' }
  | { type: 'disconnected' }
  /** The conversation was cleared: whatever the call was doing, the panel starts over. */
  | { type: 'reset' }

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
    case 'call_failed':
      return isVoiceCallActive(state) ? { status: 'failed', problem: 'unavailable' } : state
    case 'connected':
      return state.status === 'connecting' ? { status: 'live', mode: 'listening' } : state
    case 'mode_changed':
      // A vendor may report who is speaking before it reports the connection.
      return isVoiceCallActive(state) ? { status: 'live', mode: event.mode } : state
    case 'stop_pressed':
      // Stopping a call that never connected takes it back without a notice: nothing was said.
      if (state.status === 'connecting') return { status: 'idle' }
      return state.status === 'live' ? { status: 'ended' } : state
    case 'disconnected':
      // A call that drops before it connects never started; one that drops later ended.
      if (state.status === 'connecting') return { status: 'failed', problem: 'unavailable' }
      return state.status === 'live' ? { status: 'ended' } : state
    case 'reset':
      return initialVoiceSessionState
  }
}

/** One line of what was said on the call, as the vendor reports it. */
export interface VoiceTranscriptLine {
  id: string
  speaker: 'caller' | 'agent'
  text: string
  /** The vendor's id for one agent reply; a reply it reports again replaces its line. */
  responseId?: string
  /**
   * The chat messages before the line when it arrived, nearest first, so it stays in place as the
   * thread grows, and stays near its place when the message it followed leaves the thread.
   */
  afterMessageIds: readonly string[]
}

/**
 * A line as it arrives. `corrects` is the agent reply it replaces: when the caller talks over a
 * reply, the vendor reports the part that was actually spoken, with the text it reported before.
 */
export type IncomingVoiceTranscriptLine = VoiceTranscriptLine & { corrects?: string }

const latestAgentLineIndex = (lines: readonly VoiceTranscriptLine[], matches: (line: VoiceTranscriptLine) => boolean): number => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].speaker === 'agent' && matches(lines[index])) return index
  }
  return -1
}

/**
 * The line an incoming one replaces: the same vendor reply; for a correction, the latest agent
 * line with the corrected text, else the latest agent line at all, since a correction always
 * follows the reply it corrects.
 */
const replacedLineIndex = (lines: readonly VoiceTranscriptLine[], line: IncomingVoiceTranscriptLine): number => {
  if (line.responseId) {
    const index = lines.findIndex((existing) => existing.responseId === line.responseId)
    if (index >= 0) return index
  }
  if (line.corrects === undefined) return -1
  const original = line.corrects.trim()
  const matching = latestAgentLineIndex(lines, (existing) => existing.text.trim() === original)
  return matching >= 0 ? matching : latestAgentLineIndex(lines, () => true)
}

/**
 * Adds a line to the transcript, or replaces the line of the reply it reports again. A blank line
 * changes nothing (the same array comes back, so the thread does not re-render), except a blank
 * correction of a reply it finds, which removes it: the caller talked over it before any of it was
 * spoken. A correction never adds a line of its own: with no agent line to correct, it is dropped.
 */
export function appendVoiceTranscriptLine(
  lines: readonly VoiceTranscriptLine[],
  line: IncomingVoiceTranscriptLine,
): readonly VoiceTranscriptLine[] {
  const entry: VoiceTranscriptLine = {
    id: line.id,
    speaker: line.speaker,
    text: line.text,
    afterMessageIds: line.afterMessageIds,
    ...(line.responseId ? { responseId: line.responseId } : {}),
  }
  const blank = !entry.text.trim()
  if (blank && line.corrects === undefined) return lines
  const index = replacedLineIndex(lines, line)
  if (index < 0) return blank || line.corrects !== undefined ? lines : [...lines, entry]
  if (blank) return lines.filter((_existing, at) => at !== index)
  return lines.map((existing, at) => (
    at === index
      ? { ...entry, id: existing.id, afterMessageIds: existing.afterMessageIds, ...(existing.responseId && !entry.responseId ? { responseId: existing.responseId } : {}) }
      : existing
  ))
}

/**
 * Places each transcript line right after the nearest chat message that was before it when it
 * arrived and is still in the thread, keeping the order lines arrived in. A line none of whose
 * earlier messages is left goes first.
 */
export function interleaveVoiceTranscript<Message extends { id: string }, Line extends { afterMessageIds: readonly string[] }>(
  messages: readonly Message[],
  lines: readonly Line[],
): Array<Message | Line> {
  if (lines.length === 0) return [...messages]
  const knownIds = new Set(messages.map((message) => message.id))
  const leading: Line[] = []
  const linesAfter = new Map<string, Line[]>()
  for (const line of lines) {
    const anchor = line.afterMessageIds.find((id) => knownIds.has(id))
    if (anchor === undefined) {
      leading.push(line)
      continue
    }
    const bucket = linesAfter.get(anchor) ?? []
    bucket.push(line)
    linesAfter.set(anchor, bucket)
  }
  const merged: Array<Message | Line> = [...leading]
  for (const message of messages) {
    merged.push(message, ...(linesAfter.get(message.id) ?? []))
  }
  return merged
}
