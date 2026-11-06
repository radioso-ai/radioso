import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'

import type { SettingsSaveState } from '@/components/dashboard/settings/use-settings-save-status'
import { getApiErrorMessage } from '@/lib/api-error'

/** What the page's save indicator says while the draft save has failed. */
const DRAFT_SAVE_FAILED = 'Failed to save draft changes'

/** The page's save indicator and settings error. Every kind of save on the page shares them, so
 * the draft save reports only its own outcome there. */
interface PageSaveStatus {
  saveError: string | null
  setSaveState: (state: SettingsSaveState) => void
  setSaveError: (message: string | null) => void
  setSettingsError: Dispatch<SetStateAction<string | null>>
}

/**
 * The agent page's one draft save: writes the instructions and the greeting wording, each only
 * when it changed, and reports the outcome on the page's save status.
 *
 * - Only the latest save reports its outcome, so a slow earlier save cannot overwrite what a
 *   newer one showed.
 * - `onDraftMoved` runs once per save, after it ends, when any write landed, including when a
 *   later write was refused: the draft's generation moved either way.
 * - `releaseFailure` drops the failure this save put on the page, and nothing a different save
 *   has shown since.
 *
 * `writeInstructions` receives `isLatest` to stop before applying its result when a newer save
 * has started; it throws to abandon the write.
 */
export function useAgentDraftWriter({
  ready,
  hasInstructionChanges,
  hasGreetingChanges,
  writeInstructions,
  writeGreeting,
  onDraftMoved,
  status: { saveError, setSaveState, setSaveError, setSettingsError },
}: {
  ready: boolean
  hasInstructionChanges: boolean
  hasGreetingChanges: boolean
  writeInstructions: (isLatest: () => boolean) => Promise<void>
  writeGreeting: () => Promise<void>
  onDraftMoved: () => void
  status: PageSaveStatus
}): { write: () => Promise<void>; releaseFailure: () => void } {
  const sequenceRef = useRef(0)
  /** The settings error this save put on the page, while it is still the one that did. */
  const failureRef = useRef<string | null>(null)

  const write = useCallback(async () => {
    if (!ready) throw new Error('The agent editor is still loading.')
    if (!hasInstructionChanges && !hasGreetingChanges) return
    const writeId = sequenceRef.current + 1
    sequenceRef.current = writeId
    const isLatest = () => sequenceRef.current === writeId
    setSaveState('saving')
    setSaveError(null)
    let draftMoved = false
    try {
      if (hasInstructionChanges) {
        await writeInstructions(isLatest)
        draftMoved = true
      }
      await writeGreeting()
      draftMoved = true
      if (isLatest()) {
        failureRef.current = null
        setSettingsError(null)
        setSaveState('saved')
      }
    } catch (error) {
      if (isLatest()) {
        const message = getApiErrorMessage(error, 'Failed to save draft changes.')
        failureRef.current = message
        setSettingsError(message)
        setSaveState('error')
        setSaveError(DRAFT_SAVE_FAILED)
      }
      throw error
    } finally {
      if (draftMoved) onDraftMoved()
    }
  }, [hasGreetingChanges, hasInstructionChanges, onDraftMoved, ready, setSaveError, setSaveState, setSettingsError, writeGreeting, writeInstructions])

  const releaseFailure = useCallback(() => {
    const message = failureRef.current
    if (message === null) return
    failureRef.current = null
    setSettingsError((current) => (current === message ? null : current))
    if (saveError === DRAFT_SAVE_FAILED) {
      setSaveState('idle')
      setSaveError(null)
    }
  }, [saveError, setSaveError, setSaveState, setSettingsError])

  return { write, releaseFailure }
}
