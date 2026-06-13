import type { RoutineTurnSignal } from './turn-trace'

/**
 * A routine can drive several consecutive turns — it activates, then resumes on
 * later turns while it awaits the user, until it reaches a terminal step. This
 * groups those turns so the conversation thread can mark where a routine took
 * over, where the normal conversation resumes, and whether the routine ended or
 * is still paused awaiting input.
 *
 * Grouping spans the interleaved user turns: a routine that asks a question and
 * then resumes on the user's reply is one block, not two. The block ends at the
 * last assistant routine turn for that routine; trailing user turns stay outside.
 */
export interface RoutineThreadInputMessage {
  role: 'user' | 'assistant' | 'system'
  /** Present only on assistant turns that a routine drove. */
  routine?: RoutineTurnSignal
}

export interface RoutineThreadMarker {
  groupKey: string | null
  isGroupStart: boolean
  isGroupEnd: boolean
  routineId?: string
  /** Friendly name joined from the routine catalog by id; absent until resolved. */
  routineName?: string
  /** Link to the routine version that ran; only set for resolvable authored routines. */
  routineHref?: string
  /** Set only on the group-end message: did the routine finish or merely pause. */
  endState?: 'paused' | 'ended'
}

const emptyMarker = (): RoutineThreadMarker => ({
  groupKey: null,
  isGroupStart: false,
  isGroupEnd: false,
})

export const computeRoutineThreadMarkers = (
  messages: readonly RoutineThreadInputMessage[],
): RoutineThreadMarker[] => {
  const markers: RoutineThreadMarker[] = messages.map(emptyMarker)

  let i = 0
  let groupIndex = 0
  while (i < messages.length) {
    const seed = messages[i]
    if (seed.role !== 'assistant' || !seed.routine) {
      i += 1
      continue
    }

    const { routineId } = seed.routine
    let lastAssistant = i
    // Extend while the routine stays active, stepping over the user turns it is
    // waiting on. A completed turn closes the group; a different routine (or a
    // normal turn) does too.
    while (!messages[lastAssistant].routine!.completed) {
      let next = lastAssistant + 1
      while (next < messages.length && messages[next].role === 'user') {
        next += 1
      }
      const candidate = messages[next]
      if (
        candidate &&
        candidate.role === 'assistant' &&
        candidate.routine &&
        candidate.routine.routineId === routineId
      ) {
        lastAssistant = next
        continue
      }
      break
    }

    const key = `routine-${groupIndex}`
    const endState: 'paused' | 'ended' = messages[lastAssistant].routine!.completed
      ? 'ended'
      : 'paused'
    for (let k = i; k <= lastAssistant; k += 1) {
      markers[k] = {
        groupKey: key,
        isGroupStart: k === i,
        isGroupEnd: k === lastAssistant,
        routineId,
        endState: k === lastAssistant ? endState : undefined,
      }
    }
    groupIndex += 1
    i = lastAssistant + 1
  }

  return markers
}
