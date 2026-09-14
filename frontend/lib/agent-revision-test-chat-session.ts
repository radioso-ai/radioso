import type {
  AgentRevisionDetail,
  AgentRevisionState,
  AgentRevisionSummary,
  RevisionEvalRun,
} from './api-agent-revisions'
import type { TestExecutionState } from './agent-test-execution-state'
import type { ContextVariable } from './api-types'
import type { EvalCaseListItem } from './api-eval'

export type AgentRevisionTestChatSession = {
  state: AgentRevisionState | null
  revisions: AgentRevisionSummary[]
  mode: 'single' | 'compare'
  view: 'chat' | 'history'
  selected: string[]
  message: string
  execution: TestExecutionState | null
  evalRun: RevisionEvalRun | null
  error: string | null
  cases: EvalCaseListItem[]
  selectedCaseIds: string[]
  restartNotice: string | null
  revisionDetails: Record<string, AgentRevisionDetail>
  contextVariables: ContextVariable[]
  valueInputs: Record<string, string>
  valueError: string | null
  /** Revision fetch failures are cached separately from derived field validation errors. */
  revisionValueError?: string | null
  isSending: boolean
  isStarting: boolean
  isRunningEvals: boolean
  retryingEvalCase: string | null
  proactiveStartKey: string | null
  executionEpoch: number
}

const sessions = new Map<string, AgentRevisionTestChatSession>()
const listeners = new Map<string, Set<() => void>>()
let activeScope: string | null = null

export const agentRevisionTestChatSessionKey = (workspaceId: string, agentId: string) =>
  `${workspaceId}:${agentId}`

export const readAgentRevisionTestChatSession = (key: string) => sessions.get(key)

/**
 * A recursive poll loop captures the session's live values at scheduling time and must
 * re-check them against the *shared* store (not just its own instance refs) before writing
 * a result back. Refs alone do not catch an orphaned poll from a component instance that has
 * since unmounted (e.g. a tab switch) and whose own refs were never invalidated by anyone else.
 */
export const isSessionExecutionEpochCurrent = (
  session: AgentRevisionTestChatSession | undefined,
  expectedEpoch: number,
): boolean => session !== undefined && session.executionEpoch === expectedEpoch

/**
 * Eval evidence has its own, deliberately independent lifecycle: starting a new private chat
 * test must not interrupt a running eval poll, so this checks the eval run's live identity
 * rather than the chat `executionEpoch`.
 */
export const isSessionEvalRunCurrent = (
  session: AgentRevisionTestChatSession | undefined,
  expectedRunId: string,
): boolean => session?.evalRun?.id === expectedRunId

export const writeAgentRevisionTestChatSession = (
  key: string,
  update: Partial<AgentRevisionTestChatSession>,
) => {
  const current = sessions.get(key)
  if (!current) return
  sessions.set(key, { ...current, ...update })
  listeners.get(key)?.forEach((listener) => listener())
}

export const startAgentRevisionTestChatSession = (
  key: string,
  session: AgentRevisionTestChatSession,
) => {
  sessions.set(key, session)
  listeners.get(key)?.forEach((listener) => listener())
  return session
}

export const subscribeAgentRevisionTestChatSession = (key: string, listener: () => void) => {
  const keyListeners = listeners.get(key) ?? new Set<() => void>()
  keyListeners.add(listener)
  listeners.set(key, keyListeners)
  return () => {
    keyListeners.delete(listener)
    if (keyListeners.size === 0) listeners.delete(key)
  }
}

/** A workspace switch invalidates in-flight writers without retaining private content. */
export const activateAgentRevisionTestChatSessionScope = (accountId: string | null, workspaceId: string | null) => {
  if (!accountId || !workspaceId) {
    disposeAllAgentRevisionTestChatSessions()
    return
  }
  const nextScope = `${accountId}:${workspaceId}`
  if (activeScope !== null && activeScope !== nextScope) {
    sessions.clear()
    listeners.forEach((scopeListeners) => scopeListeners.forEach((listener) => listener()))
    listeners.clear()
  }
  activeScope = nextScope
}

export const disposeAllAgentRevisionTestChatSessions = () => {
  sessions.clear()
  listeners.forEach((scopeListeners) => scopeListeners.forEach((listener) => listener()))
  listeners.clear()
  activeScope = null
}

export const endAgentRevisionTestChatAuthSession = () => {
  disposeAllAgentRevisionTestChatSessions()
}

if (typeof window !== 'undefined') {
  window.addEventListener('radioso:auth-session-ended', endAgentRevisionTestChatAuthSession)
}
