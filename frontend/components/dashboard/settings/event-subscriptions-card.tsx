'use client'

import { useEffect, useState } from 'react'
import { Trash2, Webhook } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  EVENT_SUBSCRIPTION_CREATOR_KINDS,
  EVENT_SUBSCRIPTION_LABELS,
  eventSubscriptionState,
  eventSubscriptionsApi,
  type EventSubscription,
} from '@/lib/api-event-subscriptions'

import { EmptyRows, QuietRow, RowList } from './api-access-rows'
import { ConfirmDeleteDialog, useDeleteConfirmation } from './confirm-delete-dialog'
import { formatCredentialDate } from './credential-dialogs'
import { SettingsCard } from './settings-card'

/** The last push: when, and how it went. */
const lastDeliveryText = (subscription: EventSubscription): string => {
  const last = subscription.lastDelivery
  if (!last) return 'No deliveries yet'
  const status = last.statusCode === null ? '' : ` (${last.statusCode})`
  return `${last.outcome === 'delivered' ? 'Delivered' : 'Failed'}${status} ${formatCredentialDate(last.at)}`
}

const creatorText = (subscription: EventSubscription): string => {
  const kind = EVENT_SUBSCRIPTION_CREATOR_KINDS[subscription.createdBy.kind]
  return subscription.createdBy.label ? `${kind} ${subscription.createdBy.label}` : kind
}

/**
 * The URLs automation clients subscribed to this workspace's events. A client creates and removes
 * its own subscription; here an operator sees where events go, whether they arrive, and deletes one.
 */
export function EventSubscriptionsCard({ workspaceId }: { workspaceId: string }) {
  const [subscriptions, setSubscriptions] = useState<EventSubscription[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deletion = useDeleteConfirmation<EventSubscription>()

  useEffect(() => {
    let active = true
    eventSubscriptionsApi.list(workspaceId).then(
      (loaded) => {
        if (!active) return
        setSubscriptions(loaded)
        setError(null)
      },
      (loadError: unknown) => {
        if (active) setError(getApiErrorMessage(loadError, 'Failed to load event subscriptions.'))
      },
    )
    return () => {
      active = false
    }
  }, [workspaceId])

  const confirmDelete = async () => {
    const subscription = deletion.item
    if (!subscription) return
    setDeleting(true)
    try {
      await eventSubscriptionsApi.delete(workspaceId, subscription.id)
      setSubscriptions((current) => current?.filter((item) => item.id !== subscription.id) ?? null)
      setError(null)
      deletion.dismiss()
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete the event subscription.'))
      deletion.dismiss()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <SettingsCard
      id="event-subscriptions"
      icon={<Webhook className="h-5 w-5 text-primary" />}
      title="Event subscriptions"
      description="URLs that Zapier, n8n or your own code subscribed to this workspace's events. Each client adds and removes its own."
    >
      <div className="space-y-3">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {subscriptions === null && !error ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading event subscriptions…
          </div>
        ) : null}
        {subscriptions && subscriptions.length === 0 ? (
          <EmptyRows>No event subscriptions. Turning on a Zapier or n8n trigger adds one.</EmptyRows>
        ) : null}
        {subscriptions && subscriptions.length > 0 ? (
          <RowList>
            {subscriptions.map((subscription) => {
              const state = eventSubscriptionState(subscription)
              const name = `${EVENT_SUBSCRIPTION_LABELS[subscription.label]} · ${subscription.targetHost}`
              return (
                <div key={subscription.id} data-testid="event-subscription-row">
                  <QuietRow
                    name={name}
                    muted={subscription.status === 'disabled'}
                    badges={state === 'Active' ? null : <Badge variant="outline">{state}</Badge>}
                    meta={[subscription.eventTypes.join(', '), creatorText(subscription), lastDeliveryText(subscription)].join(' · ')}
                    actions={(
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        icon={<Trash2 />}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Delete ${name}`}
                        onClick={() => deletion.ask(subscription)}
                      >
                        Delete
                      </Button>
                    )}
                  />
                </div>
              )
            })}
          </RowList>
        ) : null}
      </div>
      {deletion.item ? (
        <ConfirmDeleteDialog
          open={deletion.isOpen}
          onOpenChange={(open) => { if (!open) deletion.dismiss() }}
          title="Delete event subscription?"
          description={`Events stop going to ${deletion.item.targetHost}. The ${EVENT_SUBSCRIPTION_LABELS[deletion.item.label]} trigger that created it stops firing until it subscribes again.`}
          confirmLabel="Delete subscription"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </SettingsCard>
  )
}
