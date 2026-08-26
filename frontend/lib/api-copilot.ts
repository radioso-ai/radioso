import { API_BASE, buildError, getStoredActiveWorkspaceId, request } from './api-client'
import type { DashboardRouteState } from './dashboard-routes'

export const COPILOT_PAGE_VIEWS = [
  'activity',
  'history',
  'agent',
  'documents',
  'workbench',
  'quality',
  'evals',
  'copilot',
  'other',
] as const

export type CopilotPageView = (typeof COPILOT_PAGE_VIEWS)[number]

export interface CopilotPageContext {
  view: CopilotPageView | null
  agentId: string | null
  conversationId: string | null
  selection: string | null
  entities: CopilotPageEntity[]
}

export type CopilotPageEntityType = 'agent' | 'conversation' | 'routine' | 'directive' | 'document' | 'evalCase'

export interface CopilotPageEntity {
  type: CopilotPageEntityType
  id: string
  label: string
  focused: boolean
}

export interface CopilotAvailability {
  available: boolean
  reason: 'ok' | 'no_llm_capability'
  canManage: boolean
}

export type CopilotConversationStatus = 'idle' | 'running'
export type CopilotMessageRole = 'operator' | 'copilot'
export type CopilotOutcomeStatus = 'completed' | 'budget_exhausted' | 'failed'
export type CopilotProposalTargetType = 'directive' | 'agent_setting' | 'routine'
export type CopilotProposalStatus = 'pending' | 'applied' | 'dismissed' | 'failed' | 'stale'

/** What the card states about replays run before the draft. Absent when nothing was measured. */
export interface CopilotProposalEvidenceSummary {
  total: number
  improved: number
  regressed: number
  unchanged: number
  stale: number
}

export interface CopilotProposalEvidenceCase {
  caseId: string
  caseName: string
  runId: string
  before: 'pending' | 'passing' | 'failing' | 'error'
  after: 'pass' | 'fail' | 'error' | 'recorded'
  stale: boolean
}

export interface CopilotProposalSummary {
  id: string
  targetType: CopilotProposalTargetType
  targetLabel: string
  summary: string
  status: CopilotProposalStatus
  reason?: string | null
  evidence?: CopilotProposalEvidenceSummary
}

export interface CopilotProposalPreview {
  current: unknown | null
  proposed: unknown
}

export interface CopilotProposalTargetReference {
  agentId?: string | null
  directiveId?: string | null
  routineId?: string | null
  settingKey?: string | null
  id?: string | null
}

export interface CopilotProposalDetail extends CopilotProposalSummary {
  targetRef?: CopilotProposalTargetReference
  target?: CopilotProposalTargetReference
  preview: CopilotProposalPreview
  currentVersionMatches: boolean
  reason?: string | null
  failureReason?: string | null
  appliedRef?: Record<string, unknown> | null
  /** Required by the contract and null when nothing was measured, never absent. */
  evidenceCases: CopilotProposalEvidenceCase[] | null
}

export interface CopilotProposalApplyResult {
  status: Extract<CopilotProposalStatus, 'applied' | 'failed' | 'stale'>
  appliedRef?: Record<string, unknown> | null
  reason?: string | null
}

export interface CopilotConversationSummary {
  id: string
  title: string | null
  status: CopilotConversationStatus
  createdAt: string
  updatedAt: string
}

export interface CopilotActivitySummary {
  tool: string
  outcome: 'completed' | 'failed'
  entity?: CopilotEntityReference
}

export interface CopilotEntityReference {
  type: CopilotPageEntityType
  id: string
}

export interface CopilotOperatorMessage {
  id: string
  role: 'operator'
  content: string
  createdAt: string
}

export interface CopilotAnswerMessage {
  id: string
  role: 'copilot'
  content: string
  createdAt: string
  outcome: CopilotOutcomeStatus
  activity: CopilotActivitySummary[]
  proposals: CopilotProposalSummary[]
}

export type CopilotMessage = CopilotOperatorMessage | CopilotAnswerMessage

export interface CopilotConversationDetail extends CopilotConversationSummary {
  messages: CopilotMessage[]
}

export interface CopilotTurnRequest {
  conversationId: string | null
  message: string
  pageContext: CopilotPageContext
}

export interface CopilotConversationEvent {
  conversationId: string
  turnId: string
}

export type CopilotActivityStage = 'started' | 'completed' | 'failed'

export interface CopilotActivityEvent {
  toolCallId: string
  tool: string
  stage: CopilotActivityStage
  entity?: CopilotEntityReference
}

export interface CopilotProposalEvent {
  proposalId: string
  targetType: CopilotProposalTargetType
  targetLabel: string
  summary: string
  evidence?: CopilotProposalEvidenceSummary
}

export interface CopilotChunkEvent {
  text: string
}

export interface CopilotOutcomeEvent {
  status: CopilotOutcomeStatus
}

export interface CopilotStreamResult {
  conversationId: string
  turnId: string
  answer: string
  outcome: CopilotOutcomeStatus | null
}

export interface CopilotStreamHandlers {
  onConversation?: (event: CopilotConversationEvent) => void
  onActivity?: (event: CopilotActivityEvent) => void
  onProposal?: (event: CopilotProposalEvent) => void
  onChunk?: (event: CopilotChunkEvent) => void
  onOutcome?: (event: CopilotOutcomeEvent) => void
  onDone?: () => void
}

export const deriveCopilotPageContext = (
  routeState: Pick<DashboardRouteState, 'section' | 'agentId' | 'activityTab' | 'historyItemKind' | 'historyItemId'> & {
    agentTab?: DashboardRouteState['agentTab']
  },
): CopilotPageContext => {
  const agentId = routeState.agentId ?? null
  const conversationId = routeState.historyItemKind === 'chat'
    ? routeState.historyItemId ?? null
    : null

  switch (routeState.section) {
    case 'activity':
      return {
        view: routeState.activityTab === 'all' ? 'history' : 'activity',
        agentId,
        conversationId,
        selection: null,
        entities: [],
      }
    case 'agents':
      return { view: (routeState.agentTab ?? 'chat') === 'chat' ? 'workbench' : 'agent', agentId, conversationId: null, selection: null, entities: [] }
    case 'knowledge':
      return { view: 'documents', agentId, conversationId: null, selection: null, entities: [] }
    case 'quality':
      return { view: 'quality', agentId, conversationId, selection: null, entities: [] }
    case 'eval':
      return { view: 'evals', agentId, conversationId: null, selection: null, entities: [] }
    case 'copilot':
      return {
        view: 'copilot',
        agentId,
        conversationId,
        selection: null,
        entities: [],
      }
    default:
      return { view: 'other', agentId, conversationId: null, selection: null, entities: [] }
  }
}

export const buildCopilotPageContext = (
  routeState: Parameters<typeof deriveCopilotPageContext>[0],
  entities: readonly CopilotPageEntity[] = [],
  selection: string | null = null,
): CopilotPageContext => {
  const base = deriveCopilotPageContext(routeState)
  return {
    ...base,
    selection: selection?.trim().slice(0, 2000) || null,
    entities: entities.slice(0, 30).map((entity) => ({
      ...entity,
      label: entity.label.trim().slice(0, 120) || entity.id,
    })),
  }
}

const parseSseEvent = (rawEvent: string): { eventName: string; data: string } => {
  const dataLines: string[] = []
  let eventName = 'message'

  for (const line of rawEvent.replaceAll('\r', '').split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }

  return { eventName, data: dataLines.join('\n') }
}

export const streamCopilotEvents = async (
  response: Response,
  handlers: CopilotStreamHandlers = {},
): Promise<CopilotStreamResult> => {
  if (!response.body) {
    throw new Error('Ray streaming response body was unavailable.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let conversationId = ''
  let turnId = ''
  let answer = ''
  let outcome: CopilotOutcomeStatus | null = null

  const flushEvent = (rawEvent: string) => {
    if (!rawEvent.trim()) return

    const parsed = parseSseEvent(rawEvent)
    if (!parsed.data) return

    const payload = JSON.parse(parsed.data) as Record<string, unknown>
    const eventName = parsed.eventName === 'message' && typeof payload.type === 'string'
      ? payload.type
      : parsed.eventName

    switch (eventName) {
      case 'conversation': {
        const event = payload as unknown as CopilotConversationEvent
        conversationId = event.conversationId
        turnId = event.turnId
        handlers.onConversation?.(event)
        break
      }
      case 'activity':
        handlers.onActivity?.(payload as unknown as CopilotActivityEvent)
        break
      case 'proposal':
        handlers.onProposal?.(payload as unknown as CopilotProposalEvent)
        break
      case 'chunk': {
        const event = payload as unknown as CopilotChunkEvent
        answer += event.text
        handlers.onChunk?.(event)
        break
      }
      case 'outcome': {
        const event = payload as unknown as CopilotOutcomeEvent
        outcome = event.status
        handlers.onOutcome?.(event)
        break
      }
      case 'done':
        handlers.onDone?.()
        break
      default:
        break
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })

    let delimiter = buffer.match(/\r?\n\r?\n/)
    while (delimiter?.index !== undefined) {
      flushEvent(buffer.slice(0, delimiter.index))
      buffer = buffer.slice(delimiter.index + delimiter[0].length)
      delimiter = buffer.match(/\r?\n\r?\n/)
    }

    if (done) break
  }

  if (buffer.trim()) flushEvent(buffer)

  return { conversationId, turnId, answer, outcome }
}

const copilotPath = (suffix: string) => `/copilot${suffix}`

export const copilotApi = {
  getAvailability(signal?: AbortSignal): Promise<CopilotAvailability> {
    return request<CopilotAvailability>(copilotPath('/availability'), { method: 'GET', signal }, { withSession: true })
  },

  listConversations(signal?: AbortSignal): Promise<{ conversations: CopilotConversationSummary[] }> {
    return request(copilotPath('/conversations'), { method: 'GET', signal }, { withSession: true })
  },

  getConversation(conversationId: string, signal?: AbortSignal): Promise<CopilotConversationDetail> {
    return request(copilotPath(`/conversations/${encodeURIComponent(conversationId)}`), { method: 'GET', signal }, { withSession: true })
  },

  getProposal(proposalId: string, signal?: AbortSignal): Promise<CopilotProposalDetail> {
    return request(copilotPath(`/proposals/${encodeURIComponent(proposalId)}`), { method: 'GET', signal }, { withSession: true })
  },

  applyProposal(proposalId: string): Promise<CopilotProposalApplyResult> {
    return request(copilotPath(`/proposals/${encodeURIComponent(proposalId)}/apply`), { method: 'POST' }, { withSession: true })
  },

  dismissProposal(proposalId: string): Promise<{ status: 'dismissed' }> {
    return request(copilotPath(`/proposals/${encodeURIComponent(proposalId)}/dismiss`), { method: 'POST' }, { withSession: true })
  },

  async deleteConversation(conversationId: string): Promise<void> {
    await request<void>(copilotPath(`/conversations/${encodeURIComponent(conversationId)}`), { method: 'DELETE' }, { withSession: true })
  },

  async streamTurn(data: CopilotTurnRequest, handlers: CopilotStreamHandlers = {}): Promise<CopilotStreamResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Forwarded-Prefix': '/backend',
    }
    const workspaceId = getStoredActiveWorkspaceId()
    if (workspaceId) {
      headers['X-Workspace-Id'] = workspaceId
    }
    const response = await fetch(`${API_BASE}${copilotPath('/turns')}`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      headers,
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      throw await buildError(response)
    }

    return streamCopilotEvents(response, handlers)
  },
}

export const isCopilotApiErrorStatus = (error: unknown, status: number): boolean =>
  Boolean(error && typeof error === 'object' && 'status' in error && error.status === status)
