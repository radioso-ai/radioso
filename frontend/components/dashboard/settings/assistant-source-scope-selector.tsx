'use client'

import { useMemo, useState } from 'react'
import { Database, Search } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import type { AgentSourceScope, DocumentSourceListItem } from '@/lib/api'

function SubsectionHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-0.5">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}

export function AssistantSourceScopeSelector({
  sourceScope,
  sourceList = [],
  isSourceListLoading = false,
  sourceListError = null,
  onChange,
}: {
  sourceScope: AgentSourceScope
  sourceList?: DocumentSourceListItem[]
  isSourceListLoading?: boolean
  sourceListError?: string | null
  onChange: (next: AgentSourceScope) => void
}) {
  const selectedSourceIds = sourceScope.mode === 'selected' ? sourceScope.sourceIds : []
  const [sourceSearch, setSourceSearch] = useState('')

  const filteredSources = useMemo(() => {
    const query = sourceSearch.trim().toLowerCase()
    if (!query) {
      return sourceList
    }
    return sourceList.filter((source) =>
      `${source.name} ${source.kind} ${source.externalId ?? ''}`.toLowerCase().includes(query),
    )
  }, [sourceList, sourceSearch])

  const updateSelectedSources = (nextSourceIds: string[]) => {
    onChange({
      mode: 'selected',
      sourceIds: [...new Set(nextSourceIds)],
    })
  }

  return (
    <div id="agent-source-scope-settings" className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SubsectionHeading
          title="Source scope"
          description="Choose which workspace sources this agent can use for grounded answers."
        />
        <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5" role="group">
          <button
            type="button"
            className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
              sourceScope.mode === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => onChange({ mode: 'all' })}
          >
            All sources
          </button>
          <button
            type="button"
            className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
              sourceScope.mode === 'selected' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() =>
              onChange({
                mode: 'selected',
                sourceIds: sourceScope.mode === 'selected' ? sourceScope.sourceIds : [],
              })
            }
          >
            Selected sources
          </button>
        </div>
      </div>

      {sourceScope.mode === 'selected' ? (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={sourceSearch}
              onChange={(event) => setSourceSearch(event.target.value)}
              placeholder="Search sources"
              className="pl-8"
            />
          </div>
          {sourceListError ? (
            <p className="text-sm text-destructive">{sourceListError}</p>
          ) : isSourceListLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              Loading sources...
            </div>
          ) : sourceList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No persisted sources are available yet. Switch to all sources or add knowledge first.
            </p>
          ) : (
            <div className="max-h-56 divide-y divide-border overflow-auto rounded-md border border-border">
              {filteredSources.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No sources match this search.</p>
              ) : filteredSources.map((source) => {
                const checked = selectedSourceIds.includes(source.id)
                return (
                  <label key={source.id} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        updateSelectedSources(event.target.checked
                          ? [...selectedSourceIds, source.id]
                          : selectedSourceIds.filter((sourceId) => sourceId !== source.id))
                      }}
                      className="mt-1 h-4 w-4 rounded border-border"
                    />
                    <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{source.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {source.kind} source - {source.documentCount} document{source.documentCount === 1 ? '' : 's'}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
          {selectedSourceIds.length === 0 ? (
            <p className="text-xs text-amber-700">
              This agent will not retrieve grounded context until at least one source is selected.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
