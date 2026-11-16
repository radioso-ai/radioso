'use client'

import { Activity, Trash2 } from 'lucide-react'

import {
  emailConnectionRowDomId,
  emailConnectionSender,
  healthCheckResultMessage,
  healthLabel,
  providerLabel,
  statusLabel,
  type EmailConnectionHealth,
} from '@/components/dashboard/settings/email-connection-rows'
import {
  QuietDetailSheet,
  QuietSheetDetails,
  QuietSheetField,
  QuietSheetFrame,
} from '@/components/dashboard/settings/quiet-detail-sheet'
import { focusQuietListRow } from '@/components/dashboard/settings/quiet-list'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { CustomerEmailConnection } from '@/lib/api'

export type EmailConnectionSheetActions = {
  isRowPending: (connectionId: string) => boolean
  isCheckingHealth: (connectionId: string) => boolean
  onToggleEnabled: (connection: CustomerEmailConnection, enabled: boolean) => void
  onCheckHealth: (connection: CustomerEmailConnection) => void
  onDelete: (connection: CustomerEmailConnection) => void
}

function EmailConnectionSheetBody({
  connection,
  error,
  healthResult,
  actions,
}: {
  connection: CustomerEmailConnection
  error: string | null
  healthResult: EmailConnectionHealth | null
  actions: EmailConnectionSheetActions
}) {
  const isBusy = actions.isRowPending(connection.id)
  return (
    <QuietSheetFrame
      title={connection.displayName}
      headerEnd={(
        <Switch
          checked={connection.status !== 'disabled'}
          onCheckedChange={(enabled) => actions.onToggleEnabled(connection, enabled)}
          disabled={isBusy}
          aria-label={`Enable ${connection.displayName}`}
        />
      )}
      footer={(
        <>
          <Button
            type="button"
            variant="outline"
            disabled={isBusy}
            loading={actions.isCheckingHealth(connection.id)}
            icon={<Activity />}
            onClick={() => actions.onCheckHealth(connection)}
            aria-label={`Check health of ${connection.displayName}`}
          >
            Check health
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="ml-auto text-destructive hover:text-destructive"
            disabled={isBusy}
            icon={<Trash2 />}
            onClick={() => actions.onDelete(connection)}
            aria-label={`Delete ${connection.displayName}`}
          >
            Delete
          </Button>
        </>
      )}
    >
      {/* The sheet covers the section, so a failed toggle, health check or delete says so here. */}
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {healthResult ? <p className="text-sm text-muted-foreground" role="status">{healthCheckResultMessage(healthResult)}</p> : null}
      <QuietSheetField label="Sender">{emailConnectionSender(connection)}</QuietSheetField>
      <QuietSheetDetails
        details={[
          ['Provider', providerLabel(connection.provider)],
          ['Status', statusLabel(connection.status)],
          ['Last health check', healthLabel(connection.lastHealthStatus)],
          ...(connection.lastErrorCode ? [['Last error', connection.lastErrorCode] as const] : []),
        ]}
      />
    </QuietSheetFrame>
  )
}

export function EmailConnectionDetailSheet({
  target,
  error,
  healthResult,
  actions,
  onClose,
}: {
  target: CustomerEmailConnection | null
  error: string | null
  // What the last health check run from this sheet found; null once anything else is done.
  healthResult: { connectionId: string; health: EmailConnectionHealth } | null
  actions: EmailConnectionSheetActions
  onClose: () => void
}) {
  return (
    <QuietDetailSheet
      target={target}
      onClose={onClose}
      returnFocus={(shown) => focusQuietListRow(emailConnectionRowDomId(shown.id))}
    >
      {(shown) => (
        <EmailConnectionSheetBody
          connection={shown}
          error={error}
          healthResult={healthResult?.connectionId === shown.id ? healthResult.health : null}
          actions={actions}
        />
      )}
    </QuietDetailSheet>
  )
}
