'use client'

import { useEffect, useState } from 'react'
import { Database, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  DashboardTable,
  DashboardTableBody,
  DashboardTableCell,
  DashboardTableHead,
  DashboardTableHeader,
  DashboardTableRow,
} from '@/components/dashboard/shared/dashboard-table'
import { getApiErrorMessage } from '@/lib/api-error'
import { documentsApi, type DocumentSourceListItem } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'

const formatSourceKind = (kind: DocumentSourceListItem['kind']) => {
  switch (kind) {
    case 'website':
      return 'Website'
    case 'upload':
      return 'Uploads'
    case 'api':
      return 'API'
    case 'connector':
      return 'Connector'
    default:
      return kind
  }
}

const formatDate = (value: string | null) => {
  if (!value) {
    return 'Never'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleDateString()
}

export function DocumentSourcesView() {
  const { activeWorkspaceId, isLoading: isWorkspaceLoading } = useWorkspace()
  const [sources, setSources] = useState<DocumentSourceListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const sectionShellClassName = 'w-full'

  const loadSources = async () => {
    if (isWorkspaceLoading) {
      setIsLoading(true)
      return
    }

    if (!activeWorkspaceId) {
      setSources([])
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      const response = await documentsApi.listSources()
      setSources(response.sources)
      setError(null)
    } catch (loadError) {
      setSources([])
      setError(getApiErrorMessage(loadError, 'Failed to load sources.'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Load request sets source list/error state in this effect.
    void loadSources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, isWorkspaceLoading])

  if (isLoading) {
    return (
      <div className={`${sectionShellClassName} space-y-4`}>
        <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border">
          <LogoSpinner imageClassName="h-7 w-7" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={`${sectionShellClassName} flex min-h-48 flex-col items-start justify-center gap-3`}>
        <div>
          <p className="font-medium text-foreground">Unable to load sources</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
        <Button type="button" variant="outline" onClick={() => void loadSources()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    )
  }

  if (sources.length === 0) {
    return (
      <div className={`${sectionShellClassName} flex min-h-48 flex-col items-start justify-center gap-2`}>
        <Database className="h-5 w-5 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">No sources yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Sources appear after website crawls or uploaded files create persisted source records.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={`${sectionShellClassName} space-y-4`}>
      <DashboardTable aria-label="Document sources">
        <DashboardTableHead>
          <DashboardTableHeader>Source</DashboardTableHeader>
          <DashboardTableHeader className="w-32">Kind</DashboardTableHeader>
          <DashboardTableHeader className="w-24 text-right">Documents</DashboardTableHeader>
          <DashboardTableHeader className="w-36">Last sync</DashboardTableHeader>
        </DashboardTableHead>
        <DashboardTableBody>
          {sources.map((source) => (
            <DashboardTableRow key={source.id}>
              <DashboardTableCell>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{source.name}</p>
                  {source.externalId ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">{source.externalId}</p>
                  ) : null}
                </div>
              </DashboardTableCell>
              <DashboardTableCell>
                <span className="text-sm text-muted-foreground">{formatSourceKind(source.kind)}</span>
              </DashboardTableCell>
              <DashboardTableCell>
                <p className="text-sm text-right text-muted-foreground">{source.documentCount}</p>
              </DashboardTableCell>
              <DashboardTableCell>
                <p className="text-sm text-muted-foreground">{formatDate(source.lastSyncedAt)}</p>
              </DashboardTableCell>
            </DashboardTableRow>
          ))}
        </DashboardTableBody>
      </DashboardTable>
    </div>
  )
}
