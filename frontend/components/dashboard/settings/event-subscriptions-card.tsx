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
  EVENT_SUBSCRIPTION_STATE_LABELS,
  eventSubscriptionState,
  eventSubscriptionsApi,
  type EventSubscription,
} from '@/lib/api-event-subscriptions'

import { EmptyRows, QuietRow, RowList } from './api-access-rows'
import { ConfirmDeleteDialog, useDeleteConfirmation } from './confirm-delete-dialog'
import { SettingsCard } from './settings-card'

const formatDateTime = (value: string): string => {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'unknown'
  return parsed.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** The last push and how it went, and since when pushes have been failing. */
const deliveryText = (subscription: EventSubscription): string => {
  const last = subscription.lastDelivery
  if (!last) return 'No deliveries yet'
  const status = last.statusCode === null ? '' : ` (${last.statusCode})`
  const lastText = `${last.outcome === 'delivered' ? 'Delivered' : 'Failed'}${status} ${formatDateTime(last.at)}`
  return subscription.failingSince ? `${lastText}, failing since ${formatDateTime(subscription.failingSince)}` : lastText
}

const creatorText = (subscription: EventSubscription): string => {
  const kind = EVENT_SUBSCRIPTION_CREATOR_KINDS[subscription.createdBy.kind]
  return subscription.createdBy.label ? `${kind} ${subscription.createdBy.label}` : kind
}

/** What deleting does: an active subscription stops its client's pushes; a stopped one is only cleared away. */
const deleteDescription = (subscription: EventSubscription): string => {
  const client = subscription.label === 'custom' ? 'its receiver' : `the ${EVENT_SUBSCRIPTION_LABELS[subscription.label]} client that created it`
  return subscription.status === 'active'
    ? `Events stop going to ${subscription.targetHost}, and ${client} hears nothing more until it subscribes again.`
    : `It has already stopped sending events to ${subscription.targetHost}. Deleting it clears it from this list.`
}

/**
 * The URLs a receiver subscribed to this workspace's events over the API. Here an operator sees
 * where events go, whether they arrive, and deletes one.
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
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, 'Failed to delete the event subscription.'))
    } finally {
      deletion.dismiss()
      setDeleting(false)
    }
  }

  return (
    <SettingsCard
      id="event-subscriptions"
      icon={<Webhook className="h-5 w-5 text-primary" />}
      title="Event subscriptions"
      description="URLs subscribed over the API to receive this workspace's events as signed pushes."
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
          <div data-testid="event-subscriptions-empty"><EmptyRows>No event subscriptions yet.</EmptyRows></div>
        ) : null}
        {subscriptions && subscriptions.length > 0 ? (
          <RowList>
            {subscriptions.map((subscription) => {
              const state = eventSubscriptionState(subscription)
              const name = `${EVENT_SUBSCRIPTION_LABELS[subscription.label]} · ${subscription.targetHost}`
              return (
                <div key={subscription.id} data-testid="event-subscription-row" data-state={state}>
                  <QuietRow
                    name={name}
                    muted={subscription.status === 'disabled'}
                    badges={state === 'active' ? null : <Badge variant="outline">{EVENT_SUBSCRIPTION_STATE_LABELS[state]}</Badge>}
                    meta={[subscription.eventTypes.join(', '), creatorText(subscription), deliveryText(subscription)].join(' · ')}
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
          description={deleteDescription(deletion.item)}
          confirmLabel="Delete subscription"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </SettingsCard>
  )
}
