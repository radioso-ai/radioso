'use client'

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, Loader2, RotateCcw } from 'lucide-react'

import { emailChannelErrorMessage } from '@/components/dashboard/settings/email-domain-records'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { getApiErrorStatus } from '@/lib/api-error'
import { emailChannelApi, type EmailEvent, type EmailRawMessageView } from '@/lib/api-email-channel'
import { formatBytes } from '@/lib/format-bytes'
import { relativeTimestamp } from '@/lib/relative-time'

const EVENT_PAGE_SIZE = 25

const eventStatusLabel = (event: EmailEvent): string => {
  if (event.state === 'failed') return 'Failed'
  if (event.state !== 'done') return 'Processing'
  if (event.disposition === 'drop') return 'Dropped'
  if (event.disposition === 'run_review_turn') return 'Reviewed'
  return 'Received'
}

const senderLabel = (event: EmailEvent) => {
  const { displayName, address } = event.sender
  if (displayName && address) return `${displayName} <${address}>`
  return displayName ?? address ?? 'Unknown sender'
}

type EmailMailboxEventsProps = {
  workspaceId: string
  mailboxId: string
  announce: (message: string) => void
}

type EventLog =
  | { status: 'idle' | 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: EmailEvent[]; nextCursor: string | null; isLoadingMore: boolean }

/** A mailbox's inbound event log: what arrived, what happened to it, retry, and the raw message. */
export function EmailMailboxEvents({ workspaceId, mailboxId, announce }: EmailMailboxEventsProps) {
  const [open, setOpen] = useState(false)
  const [log, setLog] = useState<EventLog>({ status: 'idle' })
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [rawDeliveryId, setRawDeliveryId] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLLIElement>())
  const focusRowRef = useRef<string | null>(null)
  const rawOpenerRef = useRef<HTMLButtonElement | null>(null)

  const load = useCallback(async () => {
    setLog({ status: 'loading' })
    try {
      const page = await emailChannelApi.listEvents(workspaceId, mailboxId, { limit: EVENT_PAGE_SIZE })
      setLog({ status: 'ready', items: page.items, nextCursor: page.nextCursor, isLoadingMore: false })
    } catch (error) {
      setLog({ status: 'error', message: emailChannelErrorMessage(error, 'Failed to load events.') })
    }
  }, [mailboxId, workspaceId])

  // A retried row can lose its Retry button, so focus lands on the row once it re-renders.
  useEffect(() => {
    const eventId = focusRowRef.current
    if (!eventId) return
    focusRowRef.current = null
    rowRefs.current.get(eventId)?.focus()
  })

  const toggle = (next: boolean) => {
    setOpen(next)
    if (next && log.status !== 'ready') void load()
  }

  const loadMore = async () => {
    if (log.status !== 'ready' || !log.nextCursor || log.isLoadingMore) return
    setLog({ ...log, isLoadingMore: true })
    try {
      const page = await emailChannelApi.listEvents(workspaceId, mailboxId, { cursor: log.nextCursor, limit: EVENT_PAGE_SIZE })
      setLog({ status: 'ready', items: [...log.items, ...page.items], nextCursor: page.nextCursor, isLoadingMore: false })
    } catch (error) {
      setLog({ ...log, isLoadingMore: false })
      setRetryError(emailChannelErrorMessage(error, 'Failed to load more events.'))
    }
  }

  const retry = async (event: EmailEvent) => {
    if (retryingId) return
    setRetryingId(event.id)
    setRetryError(null)
    try {
      const retried = await emailChannelApi.retryEvent(workspaceId, event.id)
      setLog((current) => current.status === 'ready'
        ? { ...current, items: current.items.map((item) => (item.id === retried.id ? retried : item)) }
        : current)
      focusRowRef.current = retried.id
      announce('Retry queued.')
    } catch (error) {
      setRetryError(emailChannelErrorMessage(error, 'Failed to retry.'))
    } finally {
      setRetryingId(null)
    }
  }

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="gap-1 px-2">
          Events
          <ChevronDown className="h-4 w-4" aria-hidden />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        {log.status === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading events...
          </div>
        ) : null}
        {log.status === 'error' ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-destructive" role="alert">{log.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Reload events</Button>
          </div>
        ) : null}
        {log.status === 'ready' && log.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No mail yet.</p>
        ) : null}
        {log.status === 'ready' && log.items.length > 0 ? (
          <ul className="space-y-2">
            {log.items.map((event) => (
              <li
                key={event.id}
                ref={(element) => {
                  if (element) rowRefs.current.set(event.id, element)
                  else rowRefs.current.delete(event.id)
                }}
                tabIndex={-1}
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm text-foreground">{event.subject ?? '(no subject)'}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {senderLabel(event)} · {relativeTimestamp(event.createdAt)}
                  </p>
                  {event.reason ? <p className="text-xs text-muted-foreground"><code>{event.reason}</code></p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={event.state === 'failed' ? 'default' : 'secondary'}>{eventStatusLabel(event)}</Badge>
                  {event.retryable ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void retry(event)}
                      aria-busy={retryingId === event.id || undefined}
                    >
                      {retryingId === event.id ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCcw aria-hidden />}
                      Retry
                    </Button>
                  ) : null}
                  {event.hasRaw ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={(click) => {
                        rawOpenerRef.current = click.currentTarget
                        setRawDeliveryId(event.id)
                      }}
                    >
                      View raw
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {log.status === 'ready' && log.nextCursor ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadMore()} aria-busy={log.isLoadingMore || undefined}>
            Load more
          </Button>
        ) : null}
        {retryError ? <p className="text-sm text-destructive" role="alert">{retryError}</p> : null}
      </CollapsibleContent>
      <EmailRawMessageDialog
        workspaceId={workspaceId}
        deliveryId={rawDeliveryId}
        onClose={() => setRawDeliveryId(null)}
        returnFocusRef={rawOpenerRef}
      />
    </Collapsible>
  )
}

type RawView =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; message: EmailRawMessageView }

const rawErrorMessage = (error: unknown) =>
  getApiErrorStatus(error) === 410
    ? 'The raw message was purged.'
    : emailChannelErrorMessage(error, 'Failed to load the raw message.')

function EmailRawMessageDialog({
  workspaceId,
  deliveryId,
  onClose,
  returnFocusRef,
}: {
  workspaceId: string
  deliveryId: string | null
  onClose: () => void
  /** The dialog has no trigger of its own, so closing returns focus to the button that opened it. */
  returnFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const [view, setView] = useState<RawView>({ status: 'loading' })

  useEffect(() => {
    if (!deliveryId) return
    let active = true
    queueMicrotask(() => {
      if (active) setView({ status: 'loading' })
    })
    emailChannelApi.getRawMessage(workspaceId, deliveryId).then(
      (message) => { if (active) setView({ status: 'ready', message }) },
      (error: unknown) => { if (active) setView({ status: 'error', message: rawErrorMessage(error) }) },
    )
    return () => { active = false }
  }, [deliveryId, workspaceId])

  return (
    <Dialog open={deliveryId !== null} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocusRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Raw message</DialogTitle>
          <DialogDescription>Headers and body as received, with tokens removed.</DialogDescription>
        </DialogHeader>
        {view.status === 'loading' ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading...
          </div>
        ) : null}
        {view.status === 'error' ? <p className="text-sm text-destructive" role="alert">{view.message}</p> : null}
        {view.status === 'ready' ? <RawMessageBody message={view.message} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function RawMessageBody({ message }: { message: EmailRawMessageView }) {
  return (
    <div className="min-w-0 space-y-4">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {message.headers.map((header, index) => (
          <div key={`${header.name}:${index}`} className="contents">
            <dt className="font-medium text-muted-foreground">{header.name}</dt>
            <dd className="break-all text-foreground">{header.value}</dd>
          </div>
        ))}
      </dl>
      {message.text !== null ? (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs text-foreground">
          {message.text}
        </pre>
      ) : message.sanitizedHtml !== null ? (
        // Sanitized server-side; the empty sandbox still runs no script and reaches no parent.
        <iframe
          title="Message body"
          sandbox=""
          srcDoc={message.sanitizedHtml}
          className="h-96 w-full rounded-md border border-border bg-white"
        />
      ) : (
        <p className="text-sm text-muted-foreground">No body.</p>
      )}
      {message.truncated ? <p className="text-xs text-muted-foreground">Truncated.</p> : null}
      {message.attachments.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {message.attachments.map((attachment, index) => (
            <li key={`${attachment.name}:${index}`}>
              {attachment.name} · {attachment.contentType} · {formatBytes(attachment.sizeBytes)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
