import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AGENT_GREETING_CHANGED_EVENT } from '@/lib/agent-draft-save-port'
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

const isClean = (session: GreetingSession): boolean => sameGreetingDraft(session.value, session.baseline)

/**
 * Owns the greeting wording's load, edit, dirty, and save steps for the agent page, so the
 * page-level Save draft saves it together with the instructions and the editor stays a view.
 * A greeting that failed to load is never saved: the editor would otherwise start blank and
 * overwrite the stored draft. When something else writes the draft greeting (Ray applying a
 * proposal) a clean editor reads it again; an edited one keeps the operator's edits.
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
  const [heldFor, setHeldFor] = useState(agentId)
  if (heldFor !== agentId) {
    // The page stopped showing this agent's greeting, or switched agents: nothing held for the
    // earlier one may come back, unread, when the page shows the same agent again.
    setHeldFor(agentId)
    setSession(null)
  }
  /** Counts saves as they start, so only the latest save reports its outcome. */
  const saveSequenceRef = useRef(0)
  /** Moves each time a save starts or ends, so a read that began before a write is not applied over it. */
  const writeEpochRef = useRef(0)
  const current = session && session.agentId === agentId && session.attempt === attempt ? session : null

  useEffect(() => {
    if (!agentId) return
    let active = true
    const finish = (outcome: GreetingSession['outcome'], greeting: AgentGreetingDraft) => {
      if (active) setSession({ agentId, attempt, outcome, baseline: greeting, value: greeting, issues: [] })
    }
    agentGreetingApi.getDraft(agentId).then(
      (greeting) => finish('ready', greeting),
      () => finish('error', BLANK),
    )
    return () => {
      active = false
    }
  }, [agentId, attempt])

  useEffect(() => {
    if (!agentId) return
    const readAgain = (event: Event) => {
      if ((event as CustomEvent<{ agentId?: string }>).detail?.agentId !== agentId) return
      const epoch = writeEpochRef.current
      agentGreetingApi.getDraft(agentId).then((fresh) => {
        if (writeEpochRef.current !== epoch) return
        // Decided against the session as it is when the answer arrives, so edits typed while
        // the read was in flight are kept.
        setSession((previous) => {
          if (!previous || previous.agentId !== agentId || previous.outcome !== 'ready') return previous
          if (!isClean(previous) || sameGreetingDraft(fresh, previous.baseline)) return previous
          return { ...previous, baseline: fresh, value: fresh, issues: [] }
        })
      }, () => undefined)
    }
    window.addEventListener(AGENT_GREETING_CHANGED_EVENT, readAgain)
    return () => window.removeEventListener(AGENT_GREETING_CHANGED_EVENT, readAgain)
  }, [agentId])

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

  const dirty = current?.outcome === 'ready' && !isClean(current)

  const save = useCallback(async () => {
    if (!agentId || current?.outcome !== 'ready' || isClean(current)) return
    const payload = toGreetingSavePayload(current.value, agentDefaultLocale)
    const saveId = saveSequenceRef.current + 1
    saveSequenceRef.current = saveId
    writeEpochRef.current += 1
    // The saved greeting becomes the baseline whatever was typed meanwhile, so an edit made
    // during the save stays held and stays dirty. The save's issues describe the text it sent,
    // so they are shown only while the held greeting still reads as that text.
    const settle = (update: (previous: GreetingSession, sentIsHeld: boolean) => GreetingSession) => {
      writeEpochRef.current += 1
      if (saveSequenceRef.current !== saveId) return
      setSession((previous) => previous && previous.agentId === agentId
        ? update(previous, sameGreetingDraft(toGreetingSavePayload(previous.value, agentDefaultLocale), payload))
        : previous)
    }
    try {
      const response = await agentGreetingApi.saveDraft(agentId, payload)
      settle((previous, sentIsHeld) => ({ ...previous, baseline: payload, issues: sentIsHeld ? response.validation.issues ?? [] : [] }))
    } catch (error) {
      const fieldIssues = extractValidationIssuesFromError(error)
      settle((previous, sentIsHeld) => ({ ...previous, issues: fieldIssues && sentIsHeld ? fieldIssues : previous.issues }))
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
