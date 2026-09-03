import {
  formatWebsiteEmbedDisclaimer,
  type WebsiteEmbedCopy,
  type WebsiteEmbedTheme,
} from '@/lib/embed-widget'
import { cn } from '@/lib/utils'

/** Who the visitor is talking to, resolved by the surface that owns the copy pack. */
export interface AssistantIdentity {
  /** The agent's display name, as the visitor already sees it in the header. */
  name: string
  /** Localized chip text, e.g. "AI", "KI", "ИИ". */
  aiLabel: string
  /** Longer explanation surfaced on hover. */
  description?: string
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
  if (!name && !aiLabel) {
    return null
  }

  return (
    <div
      data-testid="assistant-identity"
      className={cn('flex items-center gap-1.5 px-1 text-xs leading-none', className)}
      title={identity.description}
    >
      {name ? (
        <span className="font-medium text-muted-foreground" style={theme ? { color: theme.mutedForeground } : undefined}>
          {name}
        </span>
      ) : null}
      {aiLabel ? <AssistantAiChip label={aiLabel} theme={theme} /> : null}
    </div>
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

/** One place where the visitor-facing copy pack becomes an identity. */
export const buildAssistantIdentity = (
  copy: Pick<WebsiteEmbedCopy, 'publicChatAiLabel' | 'publicChatDisclaimerTemplate'>,
  name: string,
): AssistantIdentity => ({
  name,
  aiLabel: copy.publicChatAiLabel,
  description: formatWebsiteEmbedDisclaimer(copy, name).trim() || undefined,
})
