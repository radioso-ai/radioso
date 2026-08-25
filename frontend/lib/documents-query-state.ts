import { useQuery, type QueryClient } from '@tanstack/react-query'
import { dashboardQueryKeys } from './dashboard-query-keys'
import type { DocumentListResponse, DocumentSummary, WebsiteCrawlJobSummary } from './api'
import { documentsApi } from './api'

export const DOCUMENT_CRAWL_RECENT_SINCE_MINUTES = 30

export const fetchDocumentList = ({
  page,
  pageSize,
  signal,
  sourceId,
}: {
  page: number
  pageSize: number
  signal: AbortSignal
  sourceId: string | null
}): Promise<DocumentListResponse> => {
  const input = { limit: pageSize, offset: Math.max(0, page - 1) * pageSize }
  return sourceId
    ? documentsApi.listSourceDocuments(sourceId, input, signal)
    : documentsApi.listDocuments(input, signal)
}

export const fetchDocumentCrawlActivity = async (signal: AbortSignal) => {
  const [recent, paused] = await Promise.all([
    documentsApi.listCrawlJobs({ sinceMinutes: DOCUMENT_CRAWL_RECENT_SINCE_MINUTES }, signal),
    documentsApi.listCrawlJobs({ status: 'paused' }, signal),
  ])
  return [...new Map<string, WebsiteCrawlJobSummary>([
    ...recent.jobs,
    ...paused.jobs,
  ].map((job) => [job.id, job])).values()]
}

export const hasAuthoritativeActiveCrawl = (jobs: readonly WebsiteCrawlJobSummary[]) =>
  jobs.some((job) => job.status === 'queued' || job.status === 'processing')

export const documentCrawlPollingInterval = (
  jobs: readonly WebsiteCrawlJobSummary[],
  floorMs: number,
) => hasAuthoritativeActiveCrawl(jobs) ? 2_000 : floorMs

export const effectiveCrawlPresentation = (
  presentationWorkspaceId: string,
  workspaceId: string,
  jobs: readonly WebsiteCrawlJobSummary[],
) => presentationWorkspaceId === workspaceId ? jobs : []

export const isInitialDocumentListLoading = ({
  data,
  isPending,
}: {
  data: DocumentListResponse | undefined
  isPending: boolean
}) => isPending && !data

export const useDocumentListQuery = ({
  enabled,
  intervalMs,
  page,
  pageSize,
  sourceId,
  workspaceId,
}: {
  enabled: boolean
  intervalMs: number
  page: number
  pageSize: number
  sourceId: string | null
  workspaceId: string
}) => {
  const queryKey = dashboardQueryKeys.documents.list(workspaceId, { sourceId, page, pageSize })
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchDocumentList({ signal, sourceId, page, pageSize }),
    enabled: enabled && Boolean(workspaceId),
    refetchInterval: intervalMs,
  })
  return { ...query, queryKey }
}

export const useDocumentCrawlActivityQuery = ({
  enabled,
  floorMs,
  optimisticJobs,
  workspaceId,
}: {
  enabled: boolean
  floorMs: number
  optimisticJobs: readonly WebsiteCrawlJobSummary[]
  workspaceId: string
}) => {
  const queryKey = dashboardQueryKeys.documents.crawlActivity(workspaceId, {
    recentSinceMinutes: DOCUMENT_CRAWL_RECENT_SINCE_MINUTES,
  })
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchDocumentCrawlActivity(signal),
    enabled: enabled && Boolean(workspaceId),
    refetchInterval: (query) => documentCrawlPollingInterval(
      hasAuthoritativeActiveCrawl(optimisticJobs) ? optimisticJobs : query.state.data ?? [],
      floorMs,
    ),
  })
  return { ...query, queryKey }
}

export const patchDocumentListRow = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  patch: (document: DocumentSummary) => DocumentSummary,
) => queryClient.setQueryData<DocumentListResponse>(queryKey, (current) => current
  ? { ...current, documents: current.documents.map(patch) }
  : current)

export const removeDocumentListRow = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  documentId: string,
) => queryClient.setQueryData<DocumentListResponse>(queryKey, (current) => current
  ? {
      ...current,
      documents: current.documents.filter((document) => document.id !== documentId),
      total: Math.max(0, current.total - 1),
    }
  : current)
