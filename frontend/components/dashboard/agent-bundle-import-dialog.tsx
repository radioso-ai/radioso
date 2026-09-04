'use client'

import { AlertTriangle, CheckCircle2, FileJson, Upload } from 'lucide-react'
import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  agentBundleApi,
  groupUnresolvedByElement,
  readAgentBundle,
  unresolvedElementLabel,
  type AgentBundle,
  type AgentBundleImportResponse,
  type AgentBundleSummary,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

/**
 * Three states, in order: pick a file, confirm what it contains, read what did not
 * come across.
 *
 * The third state is the reason this dialog exists rather than a plain upload
 * button. An import that reports nothing looks identical to an import that
 * silently dropped a skill binding, and the operator finds out at answer time.
 */
export function AgentBundleImportDialog({
  open,
  onOpenChange,
  agentSettingsHrefBuilder,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentSettingsHrefBuilder: (agentId: string) => string
  onImported?: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [bundle, setBundle] = useState<AgentBundle | null>(null)
  const [summary, setSummary] = useState<AgentBundleSummary | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [result, setResult] = useState<AgentBundleImportResponse | null>(null)

  const reset = () => {
    setFileName(null)
    setBundle(null)
    setSummary(null)
    setFileError(null)
    setImportError(null)
    setIsImporting(false)
    setResult(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      reset()
    }
    onOpenChange(next)
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setFileName(file.name)
    setImportError(null)

    let text: string
    try {
      text = await file.text()
    } catch {
      // Reading can fail after the picker closes — the file moved, or the browser
      // refused it. Without this the dialog sits showing a filename and no verdict.
      setBundle(null)
      setSummary(null)
      setFileError('That file could not be read.')
      return
    }

    const read = readAgentBundle(text)
    if (!read.ok) {
      setBundle(null)
      setSummary(null)
      setFileError(read.reason)
      return
    }
    setFileError(null)
    setBundle(read.bundle)
    setSummary(read.summary)
  }

  const handleImport = async () => {
    if (!bundle) return
    setIsImporting(true)
    setImportError(null)
    let imported: AgentBundleImportResponse
    try {
      imported = await agentBundleApi.importBundle(bundle)
    } catch (caught) {
      setImportError(getApiErrorMessage(caught, 'The bundle could not be imported.'))
      return
    } finally {
      setIsImporting(false)
    }

    setResult(imported)
    // Outside the try: refreshing the agent list is housekeeping, and a failure
    // there must not be reported as an import that did not happen.
    onImported?.()
  }

  const grouped = result ? groupUnresolvedByElement(result.unresolved) : []

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{result ? 'Agent imported' : 'Import an agent bundle'}</DialogTitle>
          <DialogDescription>
            {result
              ? grouped.length > 0
                ? 'The agent is here. These parts need you before it behaves like the one you exported.'
                : 'Everything in the bundle came across.'
              : 'Creates a new agent from a bundle exported by this or another workspace.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3" data-testid="agent-bundle-import-result">
            {grouped.length === 0 ? (
              <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-4">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <p className="text-sm text-muted-foreground">
                  Nothing was left unresolved.
                </p>
              </div>
            ) : (
              grouped.map((group) => (
                <div
                  key={group.element}
                  className="rounded-lg border border-border bg-muted/20 p-4"
                  data-testid="agent-bundle-unresolved-item"
                >
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium text-foreground">
                        {unresolvedElementLabel(group.element)}
                      </p>
                      {group.entries.map((entry) => (
                        <p key={`${entry.kind}-${entry.detail}`} className="text-sm text-muted-foreground">
                          {entry.detail}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              data-testid="agent-bundle-file-input"
              onChange={(event) => {
                void handleFile(event.target.files?.[0])
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="group flex w-full items-start gap-4 rounded-lg border border-dashed border-border bg-muted/20 p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <FileJson className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium">{fileName ?? 'Choose a bundle file'}</p>
                <p className="text-xs text-muted-foreground">
                  {fileName ? 'Pick a different file' : 'A .json file exported from an agent'}
                </p>
              </div>
            </button>

            {fileError ? (
              <p className="text-sm text-destructive" data-testid="agent-bundle-file-error">{fileError}</p>
            ) : null}

            {summary ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-border p-4 text-sm">
                <dt className="text-muted-foreground">Agent</dt>
                <dd className="truncate font-medium text-foreground" data-testid="agent-bundle-summary-name">
                  {summary.agentName}
                </dd>
                <dt className="text-muted-foreground">Directives</dt>
                <dd className="text-foreground">{summary.directiveCount}</dd>
                <dt className="text-muted-foreground">Routines</dt>
                <dd className="text-foreground">{summary.routineCount}</dd>
                <dt className="text-muted-foreground">Skills</dt>
                <dd className="text-foreground">{summary.skillCount}</dd>
                <dt className="text-muted-foreground">Context variables</dt>
                <dd className="text-foreground">{summary.contextVariableCount}</dd>
              </dl>
            ) : null}

            {importError ? <p className="text-sm text-destructive">{importError}</p> : null}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
              <Button asChild data-testid="agent-bundle-open-agent">
                <a href={agentSettingsHrefBuilder(result.agentId)}>Open agent</a>
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isImporting}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleImport}
                disabled={!bundle || isImporting}
                data-testid="agent-bundle-import-button"
              >
                <Upload className="mr-2 h-4 w-4" />
                {isImporting ? 'Importing…' : 'Create agent'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
