import { useCallback } from 'react'

import { getApiErrorMessage } from '@/lib/api-error'
import { routinesApi, type RoutineDefinition } from '@/lib/api'

interface UseRoutineEnabledToggleOptions {
  agentId: string
  onSuccess: (routine: RoutineDefinition) => void
  onError: (message: string) => void
}

interface RoutineEnabledToggleCallbacks {
  onSuccess?: (routine: RoutineDefinition) => void
  onError?: (message: string) => void
}

/**
 * Whether a routine may activate is one field on the routine, so a toggle goes through the same
 * update path as any other content edit. Shared by the routines list row switch and the editor
 * header switch, whose surrounding state differs (the list replaces one row; the editor flips a
 * draft-header field optimistically and rolls it back on failure) — this owns only the network
 * call and error-message translation, leaving each caller's own state transition to itself.
 */
export function useRoutineEnabledToggle({ agentId, onSuccess, onError }: UseRoutineEnabledToggleOptions) {
  return useCallback(
    async (routineId: string, enabled: boolean, callbacks?: RoutineEnabledToggleCallbacks): Promise<void> => {
      try {
        const response = await routinesApi.updateRoutine(agentId, routineId, { enabled })
        const handleSuccess = callbacks?.onSuccess ?? onSuccess
        handleSuccess(response.routine)
      } catch (updateError) {
        const handleError = callbacks?.onError ?? onError
        handleError(getApiErrorMessage(updateError, 'Failed to update routine.'))
      }
    },
    [agentId, onSuccess, onError],
  )
}
