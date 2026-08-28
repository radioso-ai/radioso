'use client'

import { useMemo, useState } from 'react'
import { Database, Search } from 'lucide-react'

import { retrievalSettingDocs } from '@/components/dashboard/settings/settings-docs'
import { SettingFieldHeader } from '@/components/dashboard/settings/settings-flow'
import { Input } from '@/components/ui/input'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Spinner } from '@/components/ui/spinner'
import type { AgentSourceScope, DocumentSourceListItem } from '@/lib/api'

const SOURCE_SCOPE_OPTIONS: readonly SegmentedControlOption<AgentSourceScope['mode']>[] = [
  { value: 'all', label: 'All sources' },
  { value: 'selected', label: 'Selected sources' },
]

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
        <SettingFieldHeader
          label={retrievalSettingDocs.sourceScope.label}
          description={retrievalSettingDocs.sourceScope.summary}
          tooltip={retrievalSettingDocs.sourceScope.details}
          className="max-w-xl"
        />
        <SegmentedControl
          value={sourceScope.mode}
          onValueChange={(mode) => {
            if (mode === 'all') {
              onChange({ mode: 'all' })
              return
            }
            onChange({
              mode: 'selected',
              sourceIds: sourceScope.mode === 'selected' ? sourceScope.sourceIds : [],
            })
          }}
          options={SOURCE_SCOPE_OPTIONS}
        />
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
