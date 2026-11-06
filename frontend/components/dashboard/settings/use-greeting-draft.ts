import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { agentGreetingApi } from '@/lib/api-agent-greeting'
import type { AgentGreetingDraft, ExactContentItem } from '@/lib/api-types'
import {
  applyEditedItem,
  extractValidationIssuesFromError,
  sameGreetingDraft,
  toGreetingSavePayload,
  type ExactGreetingIssue,
} from '@/lib/exact-greeting-editor'

export type GreetingDraftLoadState = 'loading' | 'ready' | 'error'

/** An agent's greeting wording as the agent page edits it: loaded from the agent draft, held
 * until the page's Save draft writes it back. */
export interface GreetingDraft {
  loadState: GreetingDraftLoadState
  exactWordsEnabled: boolean
  /** `null` until the operator writes something; the editor shows a blank default-language variant meanwhile. */
  exactContent: ExactContentItem | null
  /** Field-level diagnostics from the last save; any edit to the content clears them. */
  issues: ExactGreetingIssue[]
  /** Whether the held greeting differs from the one last loaded or saved. */
  dirty: boolean
  setExactWordsEnabled: (enabled: boolean) => void
  setExactContent: (next: ExactContentItem) => void
  reload: () => void
  /** Writes the greeting to the agent draft when it changed; resolves without a request when it
   * did not, and rejects with the request's error when the draft refuses it. */
  save: () => Promise<void>
}

interface GreetingSession {
  agentId: string
  attempt: number
  outcome: 'ready' | 'error'
  /** What the draft holds, as of the last load or save. */
  baseline: AgentGreetingDraft
  value: AgentGreetingDraft
  issues: ExactGreetingIssue[]
}

const BLANK: AgentGreetingDraft = { exactWordsEnabled: false, exactContent: null }
const NO_ISSUES: ExactGreetingIssue[] = []

/**
 * Owns the greeting wording's load, edit, dirty, and save steps for the agent page, so the
 * page-level Save draft saves it together with the instructions and the editor stays a view.
 * A greeting that failed to load is never saved: the editor would otherwise start blank and
 * overwrite the stored draft.
 */
export function useGreetingDraft({
  agentId,
  agentDefaultLocale,
}: {
  agentId: string | undefined
  agentDefaultLocale: string
}): GreetingDraft {
  const [attempt, setAttempt] = useState(0)
  const [session, setSession] = useState<GreetingSession | null>(null)
  const saveSequenceRef = useRef(0)
  const current = session && session.agentId === agentId && session.attempt === attempt ? session : null

  useEffect(() => {
    if (!agentId) return
    let active = true
    const settle = (outcome: GreetingSession['outcome'], greeting: AgentGreetingDraft) => {
      if (active) setSession({ agentId, attempt, outcome, baseline: greeting, value: greeting, issues: [] })
    }
    agentGreetingApi.getDraft(agentId).then(
      (greeting) => settle('ready', greeting),
      () => settle('error', BLANK),
    )
    return () => {
      active = false
    }
  }, [agentId, attempt])

  const edit = useCallback((change: (value: AgentGreetingDraft) => AgentGreetingDraft, issues?: ExactGreetingIssue[]) => {
    setSession((previous) => previous?.outcome === 'ready'
      ? { ...previous, value: change(previous.value), issues: issues ?? previous.issues }
      : previous)
  }, [])

  const setExactWordsEnabled = useCallback((enabled: boolean) => {
    edit((value) => ({ ...value, exactWordsEnabled: enabled }))
  }, [edit])

  const setExactContent = useCallback((next: ExactContentItem) => {
    const applied = applyEditedItem(next)
    edit((value) => ({ ...value, exactContent: applied.item }), applied.issues)
  }, [edit])

  const reload = useCallback(() => setAttempt((previous) => previous + 1), [])

  const dirty = current?.outcome === 'ready' && !sameGreetingDraft(current.value, current.baseline)

  const save = useCallback(async () => {
    if (!agentId || current?.outcome !== 'ready' || sameGreetingDraft(current.value, current.baseline)) return
    const payload = toGreetingSavePayload(current.value, agentDefaultLocale)
    const saveId = saveSequenceRef.current + 1
    saveSequenceRef.current = saveId
    const settle = (change: (previous: GreetingSession) => GreetingSession) => {
      if (saveSequenceRef.current === saveId) {
        setSession((previous) => previous && previous.agentId === agentId ? change(previous) : previous)
      }
    }
    try {
      const response = await agentGreetingApi.saveDraft(agentId, payload)
      settle((previous) => ({ ...previous, baseline: payload, issues: response.validation.issues ?? [] }))
    } catch (error) {
      const fieldIssues = extractValidationIssuesFromError(error)
      if (fieldIssues) settle((previous) => ({ ...previous, issues: fieldIssues }))
      throw error
    }
  }, [agentDefaultLocale, agentId, current])

  const loadState = current?.outcome ?? 'loading'
  const exactWordsEnabled = current?.value.exactWordsEnabled ?? false
  const exactContent = current?.value.exactContent ?? null
  const issues = current?.issues ?? NO_ISSUES

  // Stable until something the page shows or saves changes, so the page's draft saver is not
  // registered again on every render.
  return useMemo(
    () => ({ loadState, exactWordsEnabled, exactContent, issues, dirty, setExactWordsEnabled, setExactContent, reload, save }),
    [dirty, exactContent, exactWordsEnabled, issues, loadState, reload, save, setExactContent, setExactWordsEnabled],
  )
}
