'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getApiErrorMessage } from '@/lib/api-error'
import { apiConnectionsApi, type ApiRequestTestResult } from '@/lib/api-connections'
import { ApiResponseTree } from './ApiResponseTree'
import {
  buildApiTestInput,
  withOutputFromValue,
  type ApiOutputDraft,
  type ApiRequestDraft,
} from './api-request-skill-model'
import type { JsonPathSegment } from './api-response-tree'

export function ApiRequestTestPanel({ connectionId, draft, onAddOutput }: {
  connectionId: string
  draft: ApiRequestDraft
  onAddOutput: (outputs: ApiOutputDraft[]) => void
}) {
  const [samples, setSamples] = useState<Record<string, string>>({})
  const [result, setResult] = useState<ApiRequestTestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Paths already declared, so the tree marks them as added.
  const declaredPaths = new Set(draft.outputs.map((output) => output.path.trim()))

  const send = async () => {
    setConfirming(false)
    setError(null)
    let input
    try {
      input = buildApiTestInput(draft, samples)
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : 'The request is incomplete.')
      return
    }
    setIsSending(true)
    try {
      setResult(await apiConnectionsApi.testRequest(connectionId, input))
    } catch (sendError) {
      setResult(null)
      setError(getApiErrorMessage(sendError, 'The test request failed.'))
    } finally {
      setIsSending(false)
    }
  }

  const pick = (segments: readonly JsonPathSegment[], value: unknown) =>
    onAddOutput(withOutputFromValue(draft.outputs, segments, value))

  const namedInputs = draft.inputs.filter((input) => input.key.trim())

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      <h4 className="text-sm font-medium text-foreground">Test request</h4>
      {namedInputs.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {namedInputs.map((input) => (
            <div key={input.id} className="space-y-1">
              <Label htmlFor={`api-sample-${input.id}`} className="font-mono text-xs">{input.key.trim()}</Label>
              <Input
                id={`api-sample-${input.id}`}
                aria-label={`Sample ${input.key.trim()}`}
                value={samples[input.id] ?? ''}
                onChange={(event) => setSamples((current) => ({ ...current, [input.id]: event.target.value }))}
                placeholder="Sample value"
              />
            </div>
          ))}
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={isSending}
        icon={<Send />}
        onClick={() => (draft.method === 'GET' ? void send() : setConfirming(true))}
      >
        Send test request
      </Button>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {result ? (
        <div className="space-y-3" aria-label="Test request result">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={result.outcome === 'completed' ? 'secondary' : 'outline'} className={result.outcome === 'completed' ? undefined : 'text-destructive'}>{result.outcome}</Badge>
            {result.reason ? <span className="text-muted-foreground">{result.reason}</span> : null}
            <span className="text-muted-foreground">
              {result.httpStatus === null ? 'No response' : `HTTP ${result.httpStatus}`} · {result.durationMs} ms
            </span>
          </div>
          {result.mismatches.length > 0 ? (
            <p className="text-sm text-destructive">Missing required: {result.mismatches.join(', ')}</p>
          ) : null}
          {result.body !== null && result.body !== undefined ? (
            <div className="space-y-1">
              <ApiResponseTree body={result.body} pickedPaths={declaredPaths} onPick={pick} />
              {result.bodyTruncated ? <p className="text-xs text-muted-foreground">Body cut at 16 KB.</p> : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No JSON body.</p>
          )}
          {Object.keys(result.outputs).length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Outputs</p>
              <pre aria-label="Projected outputs" className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-2 font-mono text-xs">
                {JSON.stringify(result.outputs, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Send a real ${draft.method} request?`}</AlertDialogTitle>
            <AlertDialogDescription>It acts on the API, as the skill would.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void send()}>Send</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
