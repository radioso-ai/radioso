'use client'

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  COPILOT_PAGE_ENTITY_TYPES,
  type CopilotActivityEvent,
  type CopilotAvailability,
  type CopilotConversationSummary,
  type CopilotMessage,
  type CopilotPageEntity,
  type CopilotPageEntityType,
} from './api-copilot'

// A registered page-context entity is exactly a CopilotPageEntity: this is the pre-serialization
// shape useCopilotEntity below builds before buildCopilotPageContext sends it to the backend, so
// it must accept the same entity types the backend's copilotPageContextSchema does (see the
// comment on COPILOT_PAGE_ENTITY_TYPES in api-copilot.ts).
export const COPILOT_ENTITY_TYPES = COPILOT_PAGE_ENTITY_TYPES

export type CopilotEntityType = CopilotPageEntityType

export type CopilotEntity = CopilotPageEntity

export type CopilotLocalMessage = CopilotMessage & {
  streaming?: boolean
  liveActivity?: CopilotActivityEvent[]
}

export interface CopilotSessionState {
  availability: CopilotAvailability | null
  conversations: CopilotConversationSummary[]
  selectedConversationId: string | null
  messages: CopilotLocalMessage[]
  input: string
  isLoading: boolean
  isLoadingConversation: boolean
  isRunning: boolean
  conversationBusy: boolean
  permissionDenied: boolean
  error: string | null
  selection: string | null
}

export const initialCopilotSessionState: CopilotSessionState = {
  availability: null,
  conversations: [],
  selectedConversationId: null,
  messages: [],
  input: '',
  isLoading: true,
  isLoadingConversation: false,
  isRunning: false,
  conversationBusy: false,
  permissionDenied: false,
  error: null,
  selection: null,
}

export const truncateCopilotSelection = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed.slice(0, 2000) : null
}

const entityKey = (entity: Pick<CopilotEntity, 'type' | 'id'>) => `${entity.type}:${entity.id}`

export const registerCopilotEntity = (
  current: readonly CopilotEntity[],
  nextEntity: CopilotEntity,
): CopilotEntity[] => {
  const next = [
    ...current.filter((entity) => entityKey(entity) !== entityKey(nextEntity)),
    {
      ...nextEntity,
      id: nextEntity.id,
      label: nextEntity.label.trim().slice(0, 120) || nextEntity.id,
      focused: Boolean(nextEntity.focused),
    },
  ]

  const focused = next.filter((entity) => entity.focused).slice(0, 3)
  const focusedKeys = new Set(focused.map(entityKey))
  const nonFocused = next.filter((entity) => !focusedKeys.has(entityKey(entity))).map((entity) => entity.focused ? { ...entity, focused: false } : entity)
  const ordered = [
    ...focused,
    ...nonFocused.slice(-Math.max(0, 30 - focused.length)),
  ]
  return ordered.slice(0, 30)
}

export const unregisterCopilotEntity = (
  current: readonly CopilotEntity[],
  entity: Pick<CopilotEntity, 'type' | 'id'>,
): CopilotEntity[] => current.filter((candidate) => entityKey(candidate) !== entityKey(entity))

interface CopilotContextValue {
  entities: CopilotEntity[]
  registerEntity: (entity: CopilotEntity) => void
  unregisterEntity: (entity: Pick<CopilotEntity, 'type' | 'id'>) => void
  session: CopilotSessionState
  setSession: Dispatch<SetStateAction<CopilotSessionState>>
  panelOpen: boolean
  selectionPrompt: { text: string; top: number; left: number } | null
  openPanel: (selection?: string | null) => void
  closePanel: () => void
  dismissSelectionPrompt: () => void
  /** Increments each time a question is queued for auto-send; the panel watches this. */
  askToken: number
  /** Open the panel and queue `question` to be sent as soon as the panel is ready. */
  askRay: (question: string) => void
  /** Atomically read-and-clear the queued question (null once consumed). */
  consumePendingQuestion: () => string | null
}

const CopilotContext = createContext<CopilotContextValue | null>(null)

export function CopilotContextProvider({ children }: { children: ReactNode }) {
  const [entities, setEntities] = useState<CopilotEntity[]>([])
  const [session, setSession] = useState(initialCopilotSessionState)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectionPrompt, setSelectionPrompt] = useState<{ text: string; top: number; left: number } | null>(null)
  const [askToken, setAskToken] = useState(0)
  // Held in a ref (not state) so consumption is synchronous — the panel's effect can
  // read-and-clear it exactly once even under StrictMode's double-invoked effects.
  const pendingQuestionRef = useRef<string | null>(null)
  const registrationSources = useRef(new Map<string, CopilotEntity[]>())

  const registerEntity = useCallback((entity: CopilotEntity) => {
    const key = entityKey(entity)
    const sources = registrationSources.current.get(key) ?? []
    sources.push(entity)
    registrationSources.current.set(key, sources)
    setEntities((current) => registerCopilotEntity(current, entity))
  }, [])

  const unregisterEntity = useCallback((entity: Pick<CopilotEntity, 'type' | 'id'>) => {
    const key = entityKey(entity)
    const sources = registrationSources.current.get(key) ?? []
    sources.pop()
    if (sources.length > 0) {
      registrationSources.current.set(key, sources)
      const previous = sources[sources.length - 1]
      setEntities((current) => registerCopilotEntity(current, previous))
      return
    }
    registrationSources.current.delete(key)
    setEntities((current) => unregisterCopilotEntity(current, entity))
  }, [])

  const openPanel = useCallback((selection?: string | null) => {
    const boundedSelection = truncateCopilotSelection(selection)
    setSession((current) => ({
      ...current,
      selection: boundedSelection ?? current.selection,
      input: boundedSelection ? `Explain this dashboard context:\n\n> ${boundedSelection.replaceAll('\n', '\n> ')}` : current.input,
    }))
    setPanelOpen(true)
    setSelectionPrompt(null)
  }, [])

  const closePanel = useCallback(() => setPanelOpen(false), [])

  const askRay = useCallback((question: string) => {
    const trimmed = truncateCopilotSelection(question)
    if (!trimmed) return
    pendingQuestionRef.current = trimmed
    setSelectionPrompt(null)
    setPanelOpen(true)
    setAskToken((token) => token + 1)
  }, [])

  const consumePendingQuestion = useCallback(() => {
    const question = pendingQuestionRef.current
    pendingQuestionRef.current = null
    return question
  }, [])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        setPanelOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection()
      const text = truncateCopilotSelection(selection?.toString())
      const anchor = selection?.anchorNode instanceof Element
        ? selection.anchorNode
        : selection?.anchorNode?.parentElement
      if (!text || !anchor?.closest('[data-dashboard-surface]') || anchor.closest('[data-copilot-panel]')) {
        setSelectionPrompt(null)
        return
      }
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null
      const rect = range?.getBoundingClientRect()
      if (!rect) return
      setSelectionPrompt({
        text,
        top: Math.max(8, rect.bottom + 8),
        left: Math.max(8, Math.min(window.innerWidth - 130, rect.left)),
      })
    }
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => document.removeEventListener('selectionchange', handleSelectionChange)
  }, [])

  const value = useMemo<CopilotContextValue>(() => ({
    entities,
    registerEntity,
    unregisterEntity,
    session,
    setSession,
    panelOpen,
    selectionPrompt,
    openPanel,
    closePanel,
    dismissSelectionPrompt: () => setSelectionPrompt(null),
    askToken,
    askRay,
    consumePendingQuestion,
  }), [askRay, askToken, closePanel, consumePendingQuestion, entities, openPanel, panelOpen, registerEntity, selectionPrompt, session, unregisterEntity])

  return <CopilotContext.Provider value={value}>{children}</CopilotContext.Provider>
}

export function useCopilotContext(): CopilotContextValue {
  const context = useContext(CopilotContext)
  if (!context) throw new Error('useCopilotContext must be used inside CopilotContextProvider')
  return context
}

export function useCopilotEntity(
  type: CopilotEntityType,
  id: string | null | undefined,
  label: string,
  focused = false,
) {
  // Ambient registration is an optional enhancement: shared primitives must
  // render unchanged when no provider is mounted (isolated tests, embeds).
  const context = useContext(CopilotContext)
  const registerEntity = context?.registerEntity
  const unregisterEntity = context?.unregisterEntity

  useEffect(() => {
    if (!id || !registerEntity || !unregisterEntity) return
    const entity = { type, id, label, focused }
    registerEntity(entity)
    return () => unregisterEntity(entity)
  }, [focused, id, label, registerEntity, type, unregisterEntity])
}

// `type` accepts a plain string, not CopilotEntityType: a caller resolving a label for an
// activity-reported CopilotEntityReference (lib/api-copilot.ts) passes a type that is not
// guaranteed to be one of the closed page-context entity types (e.g. "agent_skill", "proposal").
// It simply falls through to the id fallback below when nothing registered matches, same as today.
export const resolveCopilotEntityLabel = (
  entities: readonly CopilotEntity[],
  type: string,
  id: string,
): string => entities.find((entity) => entity.type === type && entity.id === id)?.label ?? id

export const deriveCopilotSuggestedQuestions = (
  view: string | null,
  entities: readonly CopilotEntity[],
): string[] => {
  const focused = entities.find((entity) => entity.focused)
  const ambientAgent = entities.find((entity) => entity.type === 'agent')
  if (focused?.type === 'conversation') {
    return [
      `Explain what happened in ${focused.label}`,
      'Why did this conversation take this route?',
      ...(ambientAgent ? [`Draft a change for ${ambientAgent.label}`] : []),
    ]
  }
  if (focused?.type === 'agent') {
    return [
      `What should I check on ${focused.label}?`,
      'Which settings are most likely to affect this agent?',
      `Draft a change for ${focused.label}`,
    ]
  }
  if (ambientAgent) return [`What should I check on ${ambientAgent.label}?`, `Draft a change for ${ambientAgent.label}`]
  if (view === 'quality') return ['What needs attention in this workspace?', 'What quality pattern should I investigate first?']
  if (view === 'evals') return ['Which eval cases need attention?', 'What changed in the latest eval results?']
  return ['Why did this agent behave this way?', 'What should I investigate next?']
}
