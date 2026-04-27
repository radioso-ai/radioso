import { useCallback, useEffect, useRef, useState } from 'react'

export type SettingsSaveState = 'idle' | 'saved' | 'saving' | 'error'

export interface SettingsSaveStatus {
  state: SettingsSaveState
  message?: string | null
}

export const useSettingsSaveStatus = (
  onSaveStateChange?: (input: SettingsSaveStatus) => void,
) => {
  const [saveState, setSaveState] = useState<SettingsSaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const saveSequenceRef = useRef(0)

  useEffect(() => {
    if (saveState === 'error') {
      onSaveStateChange?.({ state: 'error', message: saveError })
      return
    }

    onSaveStateChange?.({ state: saveState, message: null })
  }, [onSaveStateChange, saveError, saveState])

  const beginSave = useCallback(() => {
    const saveId = saveSequenceRef.current + 1
    saveSequenceRef.current = saveId
    setSaveState('saving')
    setSaveError(null)
    return saveId
  }, [])

  const isCurrentSave = useCallback((saveId: number) => saveSequenceRef.current === saveId, [])

  const markSaved = useCallback(() => {
    setSaveState('saved')
  }, [])

  const markError = useCallback((message = 'Failed to save changes') => {
    setSaveState('error')
    setSaveError(message)
  }, [])

  const resetSaveState = useCallback(() => {
    setSaveState('idle')
    setSaveError(null)
  }, [])

  return {
    saveState,
    saveError,
    setSaveState,
    setSaveError,
    saveSequenceRef,
    beginSave,
    isCurrentSave,
    markSaved,
    markError,
    resetSaveState,
  }
}
