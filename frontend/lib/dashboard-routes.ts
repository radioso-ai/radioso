export type DashboardSection = 'agents' | 'knowledge' | 'activity' | 'quality' | 'settings' | 'usage'
export type AgentTab = 'chat' | 'behavior' | 'channels'
export type KnowledgeTab = 'documents' | 'sources' | 'ingestion' | 'retrieval'
export type SettingsTab = 'workspace' | 'providers' | 'users'
export type HistoryFilter = 'all' | 'chat' | 'search' | 'contact'
export type HistoryItemKind = 'chat' | 'search' | 'contact'
export type QualityStatusFilter = 'success' | 'failure'
export type QualityFeedbackFilter = 'up' | 'down'
export type QualityLatencyFilter = 'lt_2s' | '2s_5s' | '5s_10s' | 'gte_10s'

export interface DashboardRouteState {
  section: DashboardSection
  workspaceId?: string
  workspacePublicRouteKey?: string
  agentId?: string
  agentTab?: AgentTab
  knowledgeTab?: KnowledgeTab
  settingsTab?: SettingsTab
  documentId?: string
  documentsPage?: number
  documentSourceFilter?: string
  historyFilter?: HistoryFilter
  historyPage?: number
  historyItemKind?: HistoryItemKind
  historyItemId?: string
  historyMessageId?: string
  qualityPage?: number
  qualityActions?: string[]
  qualityStatuses?: QualityStatusFilter[]
  qualityFeedback?: QualityFeedbackFilter[]
  qualityLatency?: QualityLatencyFilter
  qualityHasComment?: boolean
  anchor?: string
}

const routeStateKeys: Array<keyof DashboardRouteState> = [
  'section',
  'workspaceId',
  'workspacePublicRouteKey',
  'agentId',
  'agentTab',
  'knowledgeTab',
  'settingsTab',
  'documentId',
  'documentsPage',
  'documentSourceFilter',
  'historyFilter',
  'historyPage',
  'historyItemKind',
  'historyItemId',
  'historyMessageId',
  'qualityPage',
  'qualityActions',
  'qualityStatuses',
  'qualityFeedback',
  'qualityLatency',
  'qualityHasComment',
  'anchor',
]

const DEFAULT_SECTION: DashboardSection = 'agents'
const DEFAULT_AGENT_TAB: AgentTab = 'chat'
const DEFAULT_KNOWLEDGE_TAB: KnowledgeTab = 'documents'
const DEFAULT_HISTORY_FILTER: HistoryFilter = 'all'
const DEFAULT_SETTINGS_TAB: SettingsTab = 'workspace'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const parsePositiveInt = (value: string | null): number | undefined => {
  if (!value) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const parseHistoryFilter = (value: string | null): HistoryFilter | undefined => {
  if (value === 'all' || value === 'chat' || value === 'search' || value === 'contact') {
    return value
  }

  return undefined
}

const parseHistoryItemKind = (value: string | null): HistoryItemKind | undefined => {
  if (value === 'chat' || value === 'search' || value === 'contact') {
    return value
  }

  return undefined
}

const ACTION_PATTERN = /^[^:]+:[^:]+$/

const parseQualityActions = (value: string | null): string[] | undefined => {
  if (!value) {
    return undefined
  }
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => ACTION_PATTERN.test(entry))
  return parsed.length > 0 ? parsed : undefined
}

const parseQualityFeedback = (value: string | null): QualityFeedbackFilter[] | undefined => {
  if (!value) {
    return undefined
  }
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is QualityFeedbackFilter => entry === 'up' || entry === 'down')
  return parsed.length > 0 ? parsed : undefined
}

const parseQualityStatuses = (value: string | null): QualityStatusFilter[] | undefined => {
  if (!value) {
    return undefined
  }
  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is QualityStatusFilter => entry === 'success' || entry === 'failure')
  return parsed.length > 0 ? parsed : undefined
}

const parseQualityLatency = (value: string | null): QualityLatencyFilter | undefined => {
  return value === 'lt_2s' || value === '2s_5s' || value === '5s_10s' || value === 'gte_10s'
    ? value
    : undefined
}

const parseAgentTab = (value: string | null): AgentTab | undefined => {
  if (value === 'chat' || value === 'behavior' || value === 'channels') {
    return value
  }
  if (value === 'assistant') {
    return 'behavior'
  }

  return undefined
}

const isValidAgentId = (value: string): boolean => UUID_PATTERN.test(value)

const parseKnowledgeTab = (value: string | null): KnowledgeTab | undefined => {
  if (value === 'documents' || value === 'sources' || value === 'ingestion' || value === 'retrieval') {
    return value
  }

  return undefined
}

const parseSettingsTab = (value: string | null): SettingsTab | undefined => {
  if (value === 'workspace' || value === 'providers' || value === 'users') {
    return value
  }
  if (value === 'general') {
    return 'workspace'
  }

  return undefined
}

const parseAnchor = (value: string | null): string | undefined => {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  return normalized ? normalized : undefined
}

const normalizeWorkspaceId = (value: string | null): string | undefined => {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

const normalizeState = (state: DashboardRouteState): DashboardRouteState => {
  const normalized: DashboardRouteState = {
    section: state.section,
    ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
    ...(state.workspacePublicRouteKey ? { workspacePublicRouteKey: state.workspacePublicRouteKey } : {}),
  }

  if (state.section === 'agents') {
    if (state.agentId) {
      normalized.agentId = state.agentId
    }
    if (state.agentTab && state.agentTab !== DEFAULT_AGENT_TAB) {
      normalized.agentTab = state.agentTab
    }
    if (state.anchor) {
      normalized.anchor = state.anchor
    }
    return normalized
  }

  if (state.section === 'knowledge') {
    if (state.knowledgeTab && state.knowledgeTab !== DEFAULT_KNOWLEDGE_TAB) {
      normalized.knowledgeTab = state.knowledgeTab
    }
    if (state.documentId && (state.knowledgeTab ?? DEFAULT_KNOWLEDGE_TAB) === 'documents') {
      normalized.documentId = state.documentId
    }
    if (state.documentsPage && state.documentsPage > 1 && (state.knowledgeTab ?? DEFAULT_KNOWLEDGE_TAB) === 'documents') {
      normalized.documentsPage = state.documentsPage
    }
    if (state.documentSourceFilter && (state.knowledgeTab ?? DEFAULT_KNOWLEDGE_TAB) === 'documents') {
      normalized.documentSourceFilter = state.documentSourceFilter
    }
    if (state.anchor) {
      normalized.anchor = state.anchor
    }
    return normalized
  }

  if (state.section === 'activity') {
    if (state.historyFilter && state.historyFilter !== DEFAULT_HISTORY_FILTER) {
      normalized.historyFilter = state.historyFilter
    }
    if (state.historyPage && state.historyPage > 1) {
      normalized.historyPage = state.historyPage
    }
    if (state.historyItemKind && state.historyItemId) {
      normalized.historyItemKind = state.historyItemKind
      normalized.historyItemId = state.historyItemId
      if (state.historyMessageId) {
        normalized.historyMessageId = state.historyMessageId
      }
    }
    return normalized
  }

  if (state.section === 'settings') {
    if (state.settingsTab && state.settingsTab !== DEFAULT_SETTINGS_TAB) {
      normalized.settingsTab = state.settingsTab
    }
    if (state.anchor) {
      normalized.anchor = state.anchor
    }
    return normalized
  }

  if (state.section === 'quality') {
    if (state.qualityPage && state.qualityPage > 1) {
      normalized.qualityPage = state.qualityPage
    }
    if (state.qualityActions && state.qualityActions.length > 0) {
      normalized.qualityActions = [...state.qualityActions]
    }
    if (state.qualityStatuses && state.qualityStatuses.length > 0) {
      normalized.qualityStatuses = [...state.qualityStatuses]
    }
    if (state.qualityFeedback && state.qualityFeedback.length > 0) {
      normalized.qualityFeedback = [...state.qualityFeedback]
    }
    if (state.qualityLatency) {
      normalized.qualityLatency = state.qualityLatency
    }
    if (state.qualityHasComment) {
      normalized.qualityHasComment = true
    }
    return normalized
  }

  return normalized
}

export const areDashboardRouteStatesEqual = (
  left: DashboardRouteState | null | undefined,
  right: DashboardRouteState | null | undefined,
) => {
  if (!left || !right) {
    return left === right
  }

  const normalizedLeft = normalizeState(left)
  const normalizedRight = normalizeState(right)

  return routeStateKeys.every((key) => normalizedLeft[key] === normalizedRight[key])
}

const buildQueryString = (normalized: DashboardRouteState) => {
  const searchParams = new URLSearchParams()

  if (normalized.workspaceId && !normalized.workspacePublicRouteKey) {
    searchParams.set('workspace', normalized.workspaceId)
  }

  if (normalized.section === 'agents') {
    if (normalized.agentTab) {
      searchParams.set('tab', normalized.agentTab)
    }
    if (normalized.anchor) {
      searchParams.set('anchor', normalized.anchor)
    }
  }

  if (normalized.section === 'knowledge') {
    if (normalized.knowledgeTab) {
      searchParams.set('tab', normalized.knowledgeTab)
    }
    if (normalized.documentsPage) {
      searchParams.set('page', String(normalized.documentsPage))
    }
    if (normalized.documentSourceFilter) {
      searchParams.set('source', normalized.documentSourceFilter)
    }
    if (normalized.anchor) {
      searchParams.set('anchor', normalized.anchor)
    }
  }

  if (normalized.section === 'activity') {
    if (normalized.historyFilter) {
      searchParams.set('filter', normalized.historyFilter)
    }
    if (normalized.historyPage) {
      searchParams.set('page', String(normalized.historyPage))
    }
    if (normalized.historyItemKind && normalized.historyItemId) {
      searchParams.set('itemKind', normalized.historyItemKind)
      searchParams.set('itemId', normalized.historyItemId)
      if (normalized.historyMessageId) {
        searchParams.set('itemMessageId', normalized.historyMessageId)
      }
    }
  }

  if (normalized.section === 'settings') {
    if (normalized.settingsTab) {
      searchParams.set('tab', normalized.settingsTab)
    }
    if (normalized.anchor) {
      searchParams.set('anchor', normalized.anchor)
    }
  }

  if (normalized.section === 'quality') {
    if (normalized.qualityPage && normalized.qualityPage > 1) {
      searchParams.set('page', String(normalized.qualityPage))
    }
    if (normalized.qualityActions && normalized.qualityActions.length > 0) {
      searchParams.set('actions', normalized.qualityActions.join(','))
    }
    if (normalized.qualityStatuses && normalized.qualityStatuses.length > 0) {
      searchParams.set('statuses', normalized.qualityStatuses.join(','))
    }
    if (normalized.qualityFeedback && normalized.qualityFeedback.length > 0) {
      searchParams.set('feedback', normalized.qualityFeedback.join(','))
    }
    if (normalized.qualityLatency) {
      searchParams.set('latency', normalized.qualityLatency)
    }
    if (normalized.qualityHasComment) {
      searchParams.set('hasComment', 'true')
    }
  }

  const query = searchParams.toString()
  return query ? `?${query}` : ''
}

export const buildLegacyDashboardHref = (
  accountId: string,
  state: DashboardRouteState,
) => {
  const normalized = normalizeState(state)
  const basePath = `/account/${accountId}`
  let pathname = `${basePath}/${normalized.section}`

  if (normalized.section === 'agents') {
    pathname = normalized.agentId ? `${basePath}/agents/${normalized.agentId}` : `${basePath}/agents`
  }

  if (normalized.section === 'knowledge') {
    pathname = normalized.documentId
      ? `${basePath}/knowledge/documents/${normalized.documentId}`
      : `${basePath}/knowledge`
  }

  return `${pathname}${buildQueryString(normalized)}`
}

export const buildDashboardHref = (
  accountId: string,
  state: DashboardRouteState,
) => {
  const normalized = normalizeState(state)

  if (!normalized.workspacePublicRouteKey) {
    return buildLegacyDashboardHref(accountId, normalized)
  }

  const basePath = `/w/${normalized.workspacePublicRouteKey}`
  let pathname = `${basePath}/${normalized.section}`

  if (normalized.section === 'agents') {
    pathname = normalized.agentId ? `${basePath}/agents/${normalized.agentId}` : `${basePath}/agents`
  }

  if (normalized.section === 'knowledge') {
    pathname = normalized.documentId
      ? `${basePath}/knowledge/documents/${normalized.documentId}`
      : `${basePath}/knowledge`
  }

  return `${pathname}${buildQueryString(normalized)}`
}

export const buildAccountRoute = (
  accountId: string,
  section: DashboardSection = DEFAULT_SECTION,
  documentId?: string,
  workspaceId?: string,
) => buildDashboardHref(accountId, { section, documentId, workspaceId })

const parseLegacySettingsRoute = (
  searchParams?: Pick<URLSearchParams, 'get'> | null,
): Pick<DashboardRouteState, 'section' | 'agentTab' | 'knowledgeTab' | 'settingsTab' | 'anchor'> => {
  const legacyTab = searchParams?.get('tab') ?? null
  const anchor = parseAnchor(searchParams?.get('anchor') ?? null)

  if (legacyTab === 'assistant') {
    return { section: 'agents', agentTab: 'behavior', ...(anchor ? { anchor } : {}) }
  }
  if (legacyTab === 'channels' || legacyTab === 'connectors') {
    return { section: 'agents', agentTab: 'channels', ...(anchor ? { anchor } : {}) }
  }
  if (legacyTab === 'ingestion' || legacyTab === 'retrieval') {
    return { section: 'knowledge', knowledgeTab: legacyTab, ...(anchor ? { anchor } : {}) }
  }

  return {
    section: 'settings',
    settingsTab: parseSettingsTab(legacyTab),
    ...(anchor ? { anchor } : {}),
  }
}

export const parseDashboardRoute = (
  segments: string[] | undefined,
  searchParams?: Pick<URLSearchParams, 'get'> | null,
): DashboardRouteState | null => {
  const workspaceId = normalizeWorkspaceId(searchParams?.get('workspace') ?? null)

  if (!segments || segments.length === 0) {
    return {
      section: DEFAULT_SECTION,
      workspaceId,
    }
  }

  const [sectionCandidate, secondSegment, thirdSegment, ...rest] = segments

  if (sectionCandidate === 'chat') {
    return rest.length === 0 && !secondSegment
      ? normalizeState({ section: 'agents', workspaceId })
      : null
  }

  if (sectionCandidate === 'documents') {
    if (rest.length > 0 || thirdSegment) {
      return null
    }
    return normalizeState({
      section: 'knowledge',
      workspaceId,
      ...(secondSegment ? { documentId: secondSegment } : {}),
      documentsPage: parsePositiveInt(searchParams?.get('page') ?? null),
      ...(searchParams?.get('source') ? { documentSourceFilter: searchParams.get('source') ?? undefined } : {}),
    })
  }

  if (sectionCandidate === 'history') {
    if (secondSegment || thirdSegment || rest.length > 0) {
      return null
    }
    return normalizeState({
      section: 'activity',
      workspaceId,
      historyFilter: parseHistoryFilter(searchParams?.get('filter') ?? null),
      historyPage: parsePositiveInt(searchParams?.get('page') ?? null),
      historyItemKind: parseHistoryItemKind(searchParams?.get('itemKind') ?? null),
      historyItemId: searchParams?.get('itemId') ?? undefined,
      historyMessageId: searchParams?.get('itemMessageId') ?? undefined,
    })
  }

  if (sectionCandidate === 'users') {
    return rest.length === 0 && !secondSegment
      ? normalizeState({ section: 'settings', workspaceId, settingsTab: 'users' })
      : null
  }

  if (sectionCandidate === 'agents') {
    if (thirdSegment || rest.length > 0) {
      return null
    }
    if (secondSegment && !isValidAgentId(secondSegment)) {
      return null
    }
    return normalizeState({
      section: 'agents',
      workspaceId,
      ...(secondSegment ? { agentId: secondSegment } : {}),
      agentTab: parseAgentTab(searchParams?.get('tab') ?? null),
      anchor: parseAnchor(searchParams?.get('anchor') ?? null),
    })
  }

  if (sectionCandidate === 'knowledge') {
    if (secondSegment && secondSegment !== 'documents') {
      return null
    }
    if (rest.length > 0) {
      return null
    }
    return normalizeState({
      section: 'knowledge',
      workspaceId,
      knowledgeTab: parseKnowledgeTab(searchParams?.get('tab') ?? null),
      ...(thirdSegment ? { documentId: thirdSegment } : {}),
      documentsPage: parsePositiveInt(searchParams?.get('page') ?? null),
      ...(searchParams?.get('source') ? { documentSourceFilter: searchParams.get('source') ?? undefined } : {}),
      anchor: parseAnchor(searchParams?.get('anchor') ?? null),
    })
  }

  if (sectionCandidate === 'activity') {
    if (secondSegment || thirdSegment || rest.length > 0) {
      return null
    }
    return normalizeState({
      section: 'activity',
      workspaceId,
      historyFilter: parseHistoryFilter(searchParams?.get('filter') ?? null),
      historyPage: parsePositiveInt(searchParams?.get('page') ?? null),
      historyItemKind: parseHistoryItemKind(searchParams?.get('itemKind') ?? null),
      historyItemId: searchParams?.get('itemId') ?? undefined,
      historyMessageId: searchParams?.get('itemMessageId') ?? undefined,
    })
  }

  if (sectionCandidate === 'settings') {
    if (secondSegment || thirdSegment || rest.length > 0) {
      return null
    }
    return normalizeState({
      workspaceId,
      ...parseLegacySettingsRoute(searchParams),
    })
  }

  if (sectionCandidate === 'usage') {
    if (secondSegment || thirdSegment || rest.length > 0) {
      return null
    }
    return normalizeState({
      section: 'usage',
      workspaceId,
    })
  }

  if (sectionCandidate === 'quality') {
    if (secondSegment || thirdSegment || rest.length > 0) {
      return null
    }
    return normalizeState({
      section: 'quality',
      workspaceId,
      qualityPage: parsePositiveInt(searchParams?.get('page') ?? null),
      qualityActions: parseQualityActions(searchParams?.get('actions') ?? null),
      qualityStatuses: parseQualityStatuses(searchParams?.get('statuses') ?? null),
      qualityFeedback: parseQualityFeedback(searchParams?.get('feedback') ?? null),
      qualityLatency: parseQualityLatency(searchParams?.get('latency') ?? null),
      qualityHasComment: searchParams?.get('hasComment') === 'true' ? true : undefined,
    })
  }

  return null
}

export const withDashboardWorkspace = (
  state: DashboardRouteState,
  workspaceId?: string | null,
  workspacePublicRouteKey?: string | null,
): DashboardRouteState => normalizeState({
  ...state,
  ...(workspaceId ? { workspaceId } : {}),
  ...(workspacePublicRouteKey ? { workspacePublicRouteKey } : {}),
})

export const retargetDashboardRouteToWorkspace = (
  state: DashboardRouteState,
  workspaceId: string,
  workspacePublicRouteKey?: string | null,
): DashboardRouteState => {
  const workspaceState = {
    workspaceId,
    ...(workspacePublicRouteKey ? { workspacePublicRouteKey } : {}),
  }

  if (state.section === 'agents') {
    return normalizeState({
      section: 'agents',
      agentTab: state.agentTab,
      ...workspaceState,
    })
  }

  if (state.section === 'knowledge') {
    return normalizeState({
      section: 'knowledge',
      knowledgeTab: state.knowledgeTab,
      ...workspaceState,
    })
  }

  if (state.section === 'activity') {
    return normalizeState({
      section: 'activity',
      historyFilter: state.historyFilter,
      ...workspaceState,
    })
  }

  if (state.section === 'settings') {
    return normalizeState({
      section: 'settings',
      settingsTab: state.settingsTab,
      ...workspaceState,
    })
  }

  return normalizeState({
    section: state.section,
    ...workspaceState,
  })
}
