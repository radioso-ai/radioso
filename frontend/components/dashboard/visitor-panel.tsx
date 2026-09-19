'use client'

import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { LogoSpinner } from '@/components/ui/spinner'
import { useVisitorConversations } from '@/hooks/use-visitor-conversations'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import type { ChatConversationDetail, ChatConversationSummary } from '@/lib/api'
import { formatConversationLocation } from '@/lib/history-source'
import { buildVisitorPanelViewModel } from '@/lib/visitor-panel'

const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

const dash = (value: string | null | undefined): string => (value && value.trim().length > 0 ? value : '—')

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</p>
      <div className="mt-1 truncate text-sm text-foreground">{children}</div>
    </div>
  )
}

function PreviousConversationRow({
  conversation,
  onSelect,
}: {
  conversation: ChatConversationSummary
  onSelect: (conversationId: string) => void
}) {
  const title = conversation.title?.trim() || conversation.preview?.trim() || 'Untitled conversation'
  const agentLabel = getAgentOperatorLabel(
    { internalName: conversation.agentInternalName, name: conversation.agentName },
    'No agent',
  )

  return (
    <button
      type="button"
      onClick={() => onSelect(conversation.id)}
      className="flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
    >
      <span className="min-w-0 truncate text-foreground">{title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {dateFormatter.format(new Date(conversation.createdAt))} · {agentLabel}
      </span>
    </button>
  )
}

export function VisitorPanel({
  conversation,
  onSelectConversation,
  className,
}: {
  conversation: ChatConversationDetail
  onSelectConversation: (conversationId: string) => void
  className?: string
}) {
  const viewModel = buildVisitorPanelViewModel(conversation)
  const {
    conversations: previousConversations,
    isLoading: previousConversationsLoading,
    error: previousConversationsError,
  } = useVisitorConversations({
    visitorId: viewModel?.visitorId ?? null,
    excludeConversationId: conversation.conversationId,
  })

  if (!viewModel) {
    return null
  }

  const locationParts = [viewModel.city, viewModel.region, viewModel.country].filter(
    (part): part is string => Boolean(part && part.trim().length > 0),
  )
  const location = locationParts.length > 0 ? locationParts.join(', ') : null
  const browserOs = [viewModel.browser, viewModel.os].filter(Boolean).join(' · ')
  const entryPageLocation = formatConversationLocation(conversation)

  return (
    <div className={className}>
      <div className="rounded-lg border border-border/70 bg-background/70 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">Visitor</p>
          {viewModel.verified ? <Badge variant="secondary">Verified</Badge> : null}
          {viewModel.unverifiedRequestFacts ? (
            <span
              className="text-xs text-muted-foreground"
              title="An edge marker was present on this request but did not verify, so no facts are shown."
            >
              unverified
            </span>
          ) : null}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Location">{dash(location)}</Field>
          <Field label="Browser">
            <span title={viewModel.rawUserAgent ?? undefined}>{dash(browserOs || null)}</span>
          </Field>
          <Field label="Language">{dash(viewModel.language)}</Field>
          <Field label="Entry page">
            {entryPageLocation.href ? (
              <a
                href={entryPageLocation.href}
                target="_blank"
                rel="noopener noreferrer"
                title={entryPageLocation.title ?? undefined}
                className="hover:text-primary"
              >
                {entryPageLocation.text}
              </a>
            ) : (
              dash(entryPageLocation.text)
            )}
          </Field>
          <Field label="Referrer">{dash(viewModel.referrer)}</Field>
          <Field label="IP">{dash(viewModel.clientIp)}</Field>
          <Field label="First seen">
            {viewModel.firstSeenAt ? timestampFormatter.format(new Date(viewModel.firstSeenAt)) : '—'}
          </Field>
        </div>
        {viewModel.visitorId ? (
          <div className="mt-4 border-t border-border/70 pt-3">
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
              Previous conversations
            </p>
            {previousConversationsLoading ? (
              <div className="mt-2 flex items-center justify-center py-2">
                <LogoSpinner imageClassName="h-4 w-4" />
              </div>
            ) : previousConversationsError ? (
              <p className="mt-1 text-sm text-destructive">Couldn&apos;t load previous conversations</p>
            ) : previousConversations.length > 0 ? (
              <div className="mt-1">
                {previousConversations.map((previous) => (
                  <PreviousConversationRow
                    key={previous.id}
                    conversation={previous}
                    onSelect={onSelectConversation}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">None yet</p>
            )}
            {viewModel.showSeeAllPreviousConversations ? (
              <p className="mt-1 px-2 text-xs text-muted-foreground">
                see all {viewModel.previousConversationsTotal}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
