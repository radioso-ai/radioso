import {
  formatWebsiteEmbedDisclaimer,
  type WebsiteEmbedCopy,
  type WebsiteEmbedTheme,
} from '@/lib/embed-widget'
import type { ShownPrivacyNotice } from '@/lib/privacy-notice'
import { cn } from '@/lib/utils'

/** Who the visitor is talking to, resolved by the surface that owns the copy pack. */
export interface AssistantIdentity {
  /** The agent's display name, as the visitor already sees it in the header. */
  name: string
  /** Localized chip text, e.g. "AI", "KI", "ИИ". */
  aiLabel: string
  /** Longer explanation surfaced on hover. */
  description?: string
  /** The operator's privacy notice, shown with the identity before the visitor's first message. */
  notice?: PrivacyNoticeDisplay | null
}

/** The operator's line, word for word, then the link to their policy under the visitor's own label. */
export interface PrivacyNoticeDisplay {
  text: string
  url: string
  linkLabel: string
}

/**
 * Names the assistant and marks it as software. Visitors repeatedly ask whether
 * they reached a person, so the answer sits on the assistant's first message
 * rather than only in the disclaimer under the composer.
 */
export function AssistantIdentityLine({
  identity,
  theme,
  className,
}: {
  identity: AssistantIdentity
  theme?: WebsiteEmbedTheme | null
  className?: string
}) {
  const name = identity.name.trim()
  const aiLabel = identity.aiLabel.trim()
  if (!name && !aiLabel && !identity.notice) {
    return null
  }

  const line = name || aiLabel ? (
    <div
      data-testid="assistant-identity"
      className={cn('flex items-center gap-1.5 px-1 text-xs leading-none', identity.notice ? undefined : className)}
      title={identity.description}
    >
      {name ? (
        <span className="font-medium text-muted-foreground" style={theme ? { color: theme.mutedForeground } : undefined}>
          {name}
        </span>
      ) : null}
      {aiLabel ? <AssistantAiChip label={aiLabel} theme={theme} /> : null}
    </div>
  ) : null
  if (!identity.notice) {
    return line
  }
  // One block: who the visitor is talking to, and what the operator tells them about their data.
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {line}
      <PrivacyNoticeLine notice={identity.notice} theme={theme} className="px-1" />
    </div>
  )
}

/** The privacy notice as one quiet line: the operator's words, verbatim, and their policy link. */
export function PrivacyNoticeLine({
  notice,
  theme,
  className,
}: {
  notice: PrivacyNoticeDisplay
  theme?: WebsiteEmbedTheme | null
  className?: string
}) {
  const color = theme ? { color: theme.mutedForeground } : undefined
  return (
    <p data-testid="privacy-notice" className={cn('text-xs leading-snug text-muted-foreground', className)} style={color}>
      {notice.text}{' '}
      <a href={notice.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={color}>
        {notice.linkLabel}
      </a>
    </p>
  )
}

/** Deliberately low-contrast: a marker, not a badge competing with the message. */
export function AssistantAiChip({
  label,
  theme,
  title,
  className,
}: {
  label: string
  theme?: WebsiteEmbedTheme | null
  title?: string
  className?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center rounded-full border border-muted-foreground/25 px-1.5 py-px',
        'text-[10px] font-medium uppercase tracking-wide text-muted-foreground opacity-70',
        className,
      )}
      style={theme ? { color: theme.mutedForeground, borderColor: theme.panelBorder } : undefined}
    >
      {label}
    </span>
  )
}

/** The notice as a surface shows it, with the link label from the visitor's copy pack. */
const privacyNoticeDisplayOf = (
  copy: Pick<WebsiteEmbedCopy, 'publicChatPrivacyNoticeLinkLabel'>,
  notice: Pick<ShownPrivacyNotice, 'text' | 'url'> | null | undefined,
): PrivacyNoticeDisplay | null =>
  notice ? { text: notice.text, url: notice.url, linkLabel: copy.publicChatPrivacyNoticeLinkLabel } : null

/** One place where the visitor-facing copy pack becomes an identity. */
export const buildAssistantIdentity = (
  copy: Pick<WebsiteEmbedCopy, 'publicChatAiLabel' | 'publicChatDisclaimerTemplate' | 'publicChatPrivacyNoticeLinkLabel'>,
  name: string,
  notice?: Pick<ShownPrivacyNotice, 'text' | 'url'> | null,
): AssistantIdentity => ({
  name,
  aiLabel: copy.publicChatAiLabel,
  description: formatWebsiteEmbedDisclaimer(copy, name).trim() || undefined,
  notice: privacyNoticeDisplayOf(copy, notice),
})
