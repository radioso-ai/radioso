'use client'

import type { ReactNode } from 'react'

import {
  QuietDetailSheet,
  QuietSheetField,
  QuietSheetFrame,
} from '@/components/dashboard/settings/quiet-detail-sheet'
import { focusQuietListRow } from '@/components/dashboard/settings/quiet-list'
import {
  formatDeliveryStatus,
  webhookDestinationRowDomId,
} from '@/components/dashboard/settings/webhook-destination-rows'
import { Button } from '@/components/ui/button'
import type { WebhookDestination } from '@/lib/api'

export type WebhookSheetAction = 'rotate' | 'delete'

export type WebhookSheetActions = {
  // Which action of this destination is still in flight, so only its own button shows progress.
  pendingAction: (destinationId: string) => WebhookSheetAction | null
  onEdit: (destination: WebhookDestination) => void
  onRotateSecret: (destination: WebhookDestination) => void
  onDelete: (destination: WebhookDestination) => void
}

export function WebhookDestinationSheet({
  destination,
  error,
  secretNotice,
  actions,
  onClose,
}: {
  destination: WebhookDestination | null
  error: string | null
  // A secret just issued for this destination. The sheet covers the section, so it shows here.
  secretNotice: ReactNode
  actions: WebhookSheetActions
  onClose: () => void
}) {
  return (
    <QuietDetailSheet
      target={destination}
      onClose={onClose}
      returnFocus={(shown) => focusQuietListRow(webhookDestinationRowDomId(shown.id))}
    >
      {(shown) => {
        const pending = actions.pendingAction(shown.id)
        const isBusy = pending !== null
        return (
          <QuietSheetFrame
            title={shown.name}
            footer={(
              <>
                <Button type="button" variant="outline" disabled={isBusy} onClick={() => actions.onEdit(shown)} aria-label={`Edit ${shown.name}`}>
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isBusy}
                  loading={pending === 'rotate'}
                  onClick={() => actions.onRotateSecret(shown)}
                  aria-label={`Rotate secret for ${shown.name}`}
                >
                  Rotate secret
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto text-destructive hover:text-destructive"
                  disabled={isBusy}
                  loading={pending === 'delete'}
                  onClick={() => actions.onDelete(shown)}
                  aria-label={`Delete ${shown.name}`}
                >
                  Delete
                </Button>
              </>
            )}
          >
            {/* The sheet covers the section, so a failed rotate or delete started here says so here. */}
            {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
            {secretNotice}
            <QuietSheetField label="URL">
              <span className="break-all">{shown.url}</span>
            </QuietSheetField>
            <QuietSheetField label="Last delivery">{formatDeliveryStatus(shown)}</QuietSheetField>
            <QuietSheetField label="Destination ID">
              <span className="break-all font-mono text-xs">{shown.id}</span>
              <p className="mt-1 text-xs text-muted-foreground">Routines store this ID, so renaming keeps them working.</p>
            </QuietSheetField>
          </QuietSheetFrame>
        )
      }}
    </QuietDetailSheet>
  )
}
