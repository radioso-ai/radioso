export type DashboardSection = 'chat' | 'history' | 'documents' | 'settings' | 'token' | 'usage'

export interface ParsedDashboardRoute {
  section: DashboardSection
  documentId?: string
}

const DEFAULT_SECTION: DashboardSection = 'chat'

export const buildAccountRoute = (
  accountId: string,
  section: DashboardSection = DEFAULT_SECTION,
  documentId?: string,
) => {
  const basePath = `/account/${accountId}`

  if (section === 'documents' && documentId) {
    return `${basePath}/documents/${documentId}`
  }

  return `${basePath}/${section}`
}

export const parseDashboardSegments = (
  segments: string[] | undefined,
): ParsedDashboardRoute | null => {
  if (!segments || segments.length === 0) {
    return { section: DEFAULT_SECTION }
  }

  const [section, maybeDocumentId, ...rest] = segments

  if (rest.length > 0) {
    return null
  }

  if (section === 'chat' || section === 'history' || section === 'settings' || section === 'token' || section === 'usage') {
    return maybeDocumentId ? null : { section }
  }

  if (section === 'documents') {
    return maybeDocumentId
      ? { section: 'documents', documentId: maybeDocumentId }
      : { section: 'documents' }
  }

  return null
}
