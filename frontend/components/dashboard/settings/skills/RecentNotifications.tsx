'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { RefreshCw } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import { routineSkillCatalogApi } from '@/lib/api-routine-skill-catalog'
import {
  appendNotificationDeliveryPage,
  canResendConfirmation,
  NOTIFICATION_DELIVERY_KIND_LABELS,
  NOTIFICATION_DELIVERY_OUTCOME_LABELS,
  type NotificationDelivery,
  type NotificationDeliveryOutcome,
} from '@/lib/notification-deliveries'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 10

const outcomeTone = (outcome: NotificationDeliveryOutcome) => {
  if (outcome === 'sent') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  if (outcome === 'failed') return 'bg-destructive/10 text-destructive'
  return 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
}

const formatTime = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * What happened to each address of this agent's recent notices: when, which kind, who, and whether
 * it was sent or why not. A skipped address that has not confirmed can be asked again from here.
 */
export function RecentNotifications({
  agentId,
  conversationHref,
}: {
  agentId: string
  conversationHref: (conversationId: string) => string
}) {
  const [items, setItems] = useState<NotificationDelivery[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // What each resend came to, by row, so the answer stays beside the address it was about.
  const [resendResults, setResendResults] = useState<Record<string, string>>({})
  const loadVersion = useRef(0)

  useEffect(() => {
    const version = ++loadVersion.current
    // Clear the previous agent's rows in the same tick that the new load starts.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new agent starts from a loading state, not the last agent's rows
    setIsLoading(true)
    setItems([])
    setNextCursor(null)
    setError(null)
    void routineSkillCatalogApi.listNotificationDeliveries(agentId, { limit: PAGE_SIZE })
      .then((page) => {
        if (version !== loadVersion.current) return
        setItems(page.items)
        setNextCursor(page.nextCursor)
      })
      .catch((loadError: unknown) => {
        if (version !== loadVersion.current) return
        setError(getApiErrorMessage(loadError, 'Could not load recent notifications.'))
      })
      .finally(() => {
        if (version === loadVersion.current) setIsLoading(false)
      })
  }, [agentId])

  const loadMore = useCallback(() => {
    if (!nextCursor) return
    const version = loadVersion.current
    setIsLoadingMore(true)
    void routineSkillCatalogApi.listNotificationDeliveries(agentId, { cursor: nextCursor, limit: PAGE_SIZE })
      .then((page) => {
        if (version !== loadVersion.current) return
        setItems((current) => appendNotificationDeliveryPage(current, page.items))
        setNextCursor(page.nextCursor)
      })
      .catch((loadError: unknown) => {
        if (version !== loadVersion.current) return
        setError(getApiErrorMessage(loadError, 'Could not load more notifications.'))
      })
      .finally(() => {
        if (version === loadVersion.current) setIsLoadingMore(false)
      })
  }, [agentId, nextCursor])

  const resend = (item: NotificationDelivery) => {
    void routineSkillCatalogApi.resendNotificationRecipientConfirmationResult(agentId, item.recipientEmail)
      .then((result) => setResendResults((current) => ({ ...current, [item.id]: result })))
  }

  return (
    <section aria-labelledby="recent-notifications-heading" className="space-y-3">
      <h3 id="recent-notifications-heading" className="text-sm font-medium text-foreground">Recent notifications</h3>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Loading notifications...
        </div>
      ) : null}
      {!isLoading && !error && items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No notifications sent yet.
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <article className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium text-foreground">{item.recipientEmail}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatTime(item.createdAt)} · {NOTIFICATION_DELIVERY_KIND_LABELS[item.kind]}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge className={cn(outcomeTone(item.outcome))} variant="secondary">
                    {NOTIFICATION_DELIVERY_OUTCOME_LABELS[item.outcome]}
                  </Badge>
                  {canResendConfirmation(item.outcome) ? (
                    resendResults[item.id] ? (
                      <span className="text-xs text-muted-foreground">{resendResults[item.id]}</span>
                    ) : (
                      <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => resend(item)}>
                        <RefreshCw className="mr-1 h-3 w-3" /> Resend confirmation
                      </Button>
                    )
                  ) : null}
                  <Link href={conversationHref(item.conversationId)} className="text-xs text-primary hover:underline">
                    Open conversation
                  </Link>
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : null}
      {nextCursor ? (
        <Button type="button" variant="outline" size="sm" onClick={loadMore} disabled={isLoadingMore}>
          {isLoadingMore ? <Spinner className="h-4 w-4" /> : null}
          Show more
        </Button>
      ) : null}
    </section>
  )
}
