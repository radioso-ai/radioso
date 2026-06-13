import { describe, expect, it } from 'vitest'

import {
  computeRoutineThreadMarkers,
  type RoutineThreadInputMessage,
} from '@/lib/routine-thread-grouping'

const user: RoutineThreadInputMessage = { role: 'user' }
const plainAssistant: RoutineThreadInputMessage = { role: 'assistant' }

const routineAssistant = (
  routineId: string,
  { resumed = false, completed = false }: { resumed?: boolean; completed?: boolean } = {},
): RoutineThreadInputMessage => ({
  role: 'assistant',
  routine: { routineId, resumed, completed },
})

describe('computeRoutineThreadMarkers', () => {
  it('leaves non-routine conversations unmarked', () => {
    const markers = computeRoutineThreadMarkers([plainAssistant, user, plainAssistant])
    expect(markers.every((marker) => marker.groupKey === null)).toBe(true)
  })

  it('marks a single completed routine turn as both start and end', () => {
    const markers = computeRoutineThreadMarkers([
      user,
      routineAssistant('contact.request', { completed: true }),
    ])
    expect(markers[0].groupKey).toBeNull()
    expect(markers[1]).toMatchObject({
      isGroupStart: true,
      isGroupEnd: true,
      routineId: 'contact.request',
      endState: 'ended',
    })
  })

  it('spans interleaved user turns and ends when the routine completes', () => {
    const markers = computeRoutineThreadMarkers([
      user,
      routineAssistant('contact.request'),
      user,
      routineAssistant('contact.request', { resumed: true, completed: true }),
      user,
      plainAssistant,
    ])

    expect(markers.map((marker) => marker.groupKey)).toEqual([
      null,
      'routine-0',
      'routine-0',
      'routine-0',
      null,
      null,
    ])
    expect(markers[1].isGroupStart).toBe(true)
    expect(markers[3]).toMatchObject({ isGroupEnd: true, endState: 'ended' })
  })

  it('reports the end as paused when the routine never completes', () => {
    const markers = computeRoutineThreadMarkers([
      routineAssistant('survey.intake'),
      user,
      routineAssistant('survey.intake', { resumed: true }),
    ])

    expect(markers[0].isGroupStart).toBe(true)
    expect(markers[2]).toMatchObject({ isGroupEnd: true, endState: 'paused' })
  })

  it('starts a fresh group when a different routine takes over', () => {
    const markers = computeRoutineThreadMarkers([
      routineAssistant('contact.request', { completed: true }),
      user,
      routineAssistant('survey.intake', { completed: true }),
    ])

    expect(markers[0]).toMatchObject({ groupKey: 'routine-0', endState: 'ended' })
    expect(markers[2]).toMatchObject({ groupKey: 'routine-1', endState: 'ended' })
  })

  it('does not absorb a later run of the same routine after it completed', () => {
    const markers = computeRoutineThreadMarkers([
      routineAssistant('contact.request', { completed: true }),
      user,
      routineAssistant('contact.request'),
    ])

    expect(markers[0]).toMatchObject({ groupKey: 'routine-0', isGroupEnd: true, endState: 'ended' })
    expect(markers[2]).toMatchObject({ groupKey: 'routine-1', isGroupStart: true, endState: 'paused' })
  })
})
