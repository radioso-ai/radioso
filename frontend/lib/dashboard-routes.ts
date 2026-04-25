export type DashboardSection = 'chat' | 'history' | 'documents' | 'evals' | 'settings' | 'users'
export type HistoryFilter = 'all' | 'chat' | 'search'
export type HistoryItemKind = 'chat' | 'search'
export type SettingsTab = 'workspace' | 'assistant' | 'channels' | 'ingestion' | 'retrieval'

export interface DashboardRouteState {
  section: DashboardSection
  workspaceId?: string
  workspacePublicRouteKey?: string
  documentId?: string
  documentsPage?: number
  historyFilter?: HistoryFilter
  historyPage?: number
  historyItemKind?: HistoryItemKind
  historyItemId?: string
  evalDatasetId?: string
  settingsTab?: SettingsTab
  settingsAnchor?: string
}

const routeStateKeys: Array<keyof DashboardRouteState> = [
  'section',
  'workspaceId',
  'workspacePublicRouteKey',
  'documentId',
  'documentsPage',
  'historyFilter',
  'historyPage',
  'historyItemKind',
  'historyItemId',
  'evalDatasetId',
  'settingsTab',
  'settingsAnchor',
]

const DEFAULT_SECTION: DashboardSection = 'chat'
const DEFAULT_HISTORY_FILTER: HistoryFilter = 'all'
const DEFAULT_SETTINGS_TAB: SettingsTab = 'workspace'

const parsePositiveInt = (value: string | null): number | undefined => {
  if (!value) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

const parseSection = (value: string | undefined): DashboardSection | null => {
  if (value === 'chat' || value === 'history' || value === 'documents' || value === 'evals' || value === 'settings' || value === 'users') {
    return value
  }

  return null
}

const parseHistoryFilter = (value: string | null): HistoryFilter | undefined => {
  if (value === 'all' || value === 'chat' || value === 'search') {
    return value
  }

  return undefined
}

const parseHistoryItemKind = (value: string | null): HistoryItemKind | undefined => {
  if (value === 'chat' || value === 'search') {
    return value
  }

  return undefined
}

const parseSettingsTab = (value: string | null): SettingsTab | undefined => {
  if (value === 'workspace' || value === 'assistant' || value === 'channels' || value === 'ingestion' || value === 'retrieval') {
    return value
  }
  if (value === 'general') {
    return 'workspace'
  }
  if (value === 'connectors') {
    return 'channels'
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

  if (state.section === 'documents') {
    if (state.documentId) {
      normalized.documentId = state.documentId
    }
    if (state.documentsPage && state.documentsPage > 1) {
      normalized.documentsPage = state.documentsPage
    }
    return normalized
  }

  if (state.section === 'history') {
    if (state.historyFilter && state.historyFilter !== DEFAULT_HISTORY_FILTER) {
      normalized.historyFilter = state.historyFilter
    }
    if (state.historyPage && state.historyPage > 1) {
      normalized.historyPage = state.historyPage
    }
    if (state.historyItemKind && state.historyItemId) {
      normalized.historyItemKind = state.historyItemKind
      normalized.historyItemId = state.historyItemId
    }
    return normalized
  }

  if (state.section === 'evals') {
    if (state.evalDatasetId) {
      normalized.evalDatasetId = state.evalDatasetId
    }
    return normalized
  }

  if (state.section === 'settings') {
    if (state.settingsTab && state.settingsTab !== DEFAULT_SETTINGS_TAB) {
      normalized.settingsTab = state.settingsTab
    }
    if (state.settingsAnchor) {
      normalized.settingsAnchor = state.settingsAnchor
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

  if (normalized.section === 'documents' && normalized.documentsPage) {
    searchParams.set('page', String(normalized.documentsPage))
  }

  if (normalized.section === 'history') {
    if (normalized.historyFilter) {
      searchParams.set('filter', normalized.historyFilter)
    }
    if (normalized.historyPage) {
      searchParams.set('page', String(normalized.historyPage))
    }
    if (normalized.historyItemKind && normalized.historyItemId) {
      searchParams.set('itemKind', normalized.historyItemKind)
      searchParams.set('itemId', normalized.historyItemId)
    }
  }

  if (normalized.section === 'evals' && normalized.evalDatasetId) {
    searchParams.set('dataset', normalized.evalDatasetId)
  }

  if (normalized.section === 'settings') {
    if (normalized.settingsTab) {
      searchParams.set('tab', normalized.settingsTab)
    }
    if (normalized.settingsAnchor) {
      searchParams.set('anchor', normalized.settingsAnchor)
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

  if (normalized.section === 'documents' && normalized.documentId) {
    pathname = `${basePath}/documents/${normalized.documentId}`
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

  if (normalized.section === 'documents' && normalized.documentId) {
    pathname = `${basePath}/documents/${normalized.documentId}`
  }

  return `${pathname}${buildQueryString(normalized)}`
}

export const buildAccountRoute = (
  accountId: string,
  section: DashboardSection = DEFAULT_SECTION,
  documentId?: string,
  workspaceId?: string,
) => buildDashboardHref(accountId, { section, documentId, workspaceId })

export const parseDashboardRoute = (
  segments: string[] | undefined,
  searchParams?: Pick<URLSearchParams, 'get'> | null,
): DashboardRouteState | null => {
  if (!segments || segments.length === 0) {
    return {
      section: DEFAULT_SECTION,
      workspaceId: normalizeWorkspaceId(searchParams?.get('workspace') ?? null),
    }
  }

  const [sectionCandidate, maybeDocumentId, ...rest] = segments
  const section = parseSection(sectionCandidate)

  if (!section || rest.length > 0) {
    return null
  }

  if (section !== 'documents' && maybeDocumentId) {
    return null
  }

  const workspaceId = normalizeWorkspaceId(searchParams?.get('workspace') ?? null)

  if (section === 'documents') {
    return normalizeState({
      section,
      workspaceId,
      ...(maybeDocumentId ? { documentId: maybeDocumentId } : {}),
      documentsPage: parsePositiveInt(searchParams?.get('page') ?? null),
    })
  }

  if (section === 'history') {
    return normalizeState({
      section,
      workspaceId,
      historyFilter: parseHistoryFilter(searchParams?.get('filter') ?? null),
      historyPage: parsePositiveInt(searchParams?.get('page') ?? null),
      historyItemKind: parseHistoryItemKind(searchParams?.get('itemKind') ?? null),
      historyItemId: searchParams?.get('itemId') ?? undefined,
    })
  }

  if (section === 'evals') {
    return {
      section: 'evals',
      workspaceId: normalizeWorkspaceId(searchParams?.get('workspace') ?? null),
      evalDatasetId: searchParams?.get('dataset') ?? undefined,
    }
  }

  if (section === 'settings') {
    return normalizeState({
      section,
      workspaceId,
      settingsTab: parseSettingsTab(searchParams?.get('tab') ?? null),
      settingsAnchor: parseAnchor(searchParams?.get('anchor') ?? null),
    })
  }

  return normalizeState({ section, workspaceId })
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
