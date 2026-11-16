'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, KeyRound, Trash2 } from 'lucide-react'

import { QuietSheetDetails, QuietSheetField } from '@/components/dashboard/settings/quiet-detail-sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { McpConnection } from '@/lib/api-external-skills'
import {
  CONNECTION_ACTIONS,
  describeConnectionUsage,
  McpStatusBadge,
  type McpConnectionAction,
  type McpConnectionTestResult,
} from './mcp-connection-status'

export type McpConnectionActions = {
  isPending: (action: McpConnectionAction, connectionId: string) => boolean
  onBack: () => void
  onTest: (connectionId: string) => void
  onAuthorize: (connectionId: string) => void
  // Resolves true once the token is saved, so the form knows when to close.
  onReplaceToken: (connectionId: string, token: string) => Promise<boolean>
  onDelete: (connectionId: string) => void
}

// One connection in full, drilled into from its row inside the MCP connections panel. It is not a
// sheet of its own: the panel is already a sheet, so the list swaps for this view in place.
export function McpConnectionDetail({
  connection,
  testResult,
  isReloading,
  actions,
}: {
  connection: McpConnection
  testResult: McpConnectionTestResult | undefined
  isReloading: boolean
  actions: McpConnectionActions
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Null while the replacement form is closed. The secret lives only as long as this view.
  const [newToken, setNewToken] = useState<string | null>(null)
  const { id, displayName: name } = connection
  const isTesting = actions.isPending('test', id)
  const isBusy = CONNECTION_ACTIONS.some((action) => actions.isPending(action, id))
  const usage = describeConnectionUsage(connection.usedByAgents)

  // The row that opened this view is gone, so the keyboard starts at the connection's name.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const saveToken = async () => {
    const token = newToken?.trim()
    if (!token) return
    if (await actions.onReplaceToken(id, token)) setNewToken(null)
  }

  return (
    <div className="space-y-5">
      <Button type="button" variant="ghost" size="sm" className="-ml-2" icon={<ArrowLeft />} onClick={actions.onBack}>
        Back to connections
      </Button>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 ref={headingRef} tabIndex={-1} className="break-words font-display text-xl outline-none">{name}</h3>
        <McpStatusBadge status={connection.status} />
      </div>

      <QuietSheetField label="Server URL"><span className="break-all">{connection.serverUrl}</span></QuietSheetField>
      <QuietSheetDetails
        details={[
          ['Authentication', connection.authMethod === 'oauth' ? 'OAuth' : 'Access token'],
          ...(usage ? [['Used by', usage] as const] : []),
        ]}
      />

      {testResult?.status === 'success' ? (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          Connected · {testResult.toolCount} {testResult.toolCount === 1 ? 'tool' : 'tools'} found
        </p>
      ) : testResult?.status === 'error' ? (
        <p role="alert" className="text-sm text-destructive">{testResult.message}</p>
      ) : null}

      {newToken !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            aria-label={`New access token for ${name}`}
            placeholder="New access token"
            className="max-w-sm"
            value={newToken}
            onChange={(event) => setNewToken(event.target.value)}
            autoFocus
          />
          <Button
            type="button"
            size="sm"
            aria-label={`Save token for ${name}`}
            onClick={() => void saveToken()}
            disabled={!newToken.trim() || isBusy}
            loading={actions.isPending('replace-token', id)}
          >
            Save token
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setNewToken(null)}>
            Cancel
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Test connection to ${name}`}
          loading={isTesting}
          disabled={isReloading || isBusy}
          onClick={() => actions.onTest(id)}
        >
          {isTesting ? 'Testing…' : 'Test connection'}
        </Button>
        {connection.authMethod === 'oauth' && connection.status !== 'authorized' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            icon={<KeyRound />}
            loading={actions.isPending('authorize', id)}
            disabled={isBusy}
            onClick={() => actions.onAuthorize(id)}
          >
            {connection.status === 'needs_reauth' ? 'Re-authorize' : 'Authorize'}
          </Button>
        ) : null}
        {connection.authMethod === 'access_token' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            icon={<KeyRound />}
            aria-label={`Replace token for ${name}`}
            disabled={isBusy}
            onClick={() => setNewToken((current) => current ?? '')}
          >
            Replace token
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={<Trash2 />}
          className="ml-auto text-destructive hover:text-destructive"
          aria-label={`Delete ${name}`}
          loading={actions.isPending('delete', id)}
          disabled={isBusy}
          onClick={() => actions.onDelete(id)}
        >
          Delete
        </Button>
      </div>
    </div>
  )
}
