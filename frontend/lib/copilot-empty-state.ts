import type { CopilotEmptyState } from '@/lib/api-copilot'
import { deriveCopilotSuggestedQuestions, type CopilotEntity } from '@/lib/copilot-context'

type CopilotEmptyChip =
  /** Takes the operator to the dashboard surface that completes a setup step. */
  | { kind: 'link'; text: string; href: string }
  /** Puts a request into the composer for the operator to send Ray. */
  | { kind: 'prompt'; text: string }

export type CopilotEmptyStateLoad =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; state: CopilotEmptyState }

interface ResolvedCopilotEmptyState {
  status: 'pending' | 'ready'
  /** Ray's own words, written by the server for this workspace and language. */
  greeting: string | null
  /**
   * Whether the panel's fixed "ask me what happened" line may show. It is retrospective, so it only
   * shows where the server has said a conversation exists.
   */
  showStaticSubtitle: boolean
  chips: CopilotEmptyChip[]
}

/** A workspace-scoped dashboard path. The server builds these, but a chip navigates on click, so the client checks. */
export const isDashboardHref = (href: string): boolean => /^\/w\/[^/?#]+\/[^/]/u.test(href)

/** The language and region of the browser's locale: all a locale tag the server accepts can carry. */
export const requestLocale = (browserLanguage: string | undefined): string | null => {
  if (!browserLanguage) return null
  const [language, region] = browserLanguage.split('-')
  if (!/^[A-Za-z]{2,3}$/u.test(language ?? '')) return null
  return region && /^[A-Za-z0-9]{2,8}$/u.test(region) ? `${language}-${region}` : language
}

const screenChips = (view: string | null, entities: readonly CopilotEntity[]): CopilotEmptyChip[] =>
  deriveCopilotSuggestedQuestions(view, entities).map((text) => ({ kind: 'prompt', text }))

/**
 * Decides what the empty panel shows from what the server said about the workspace and what the
 * operator is looking at. While setup is open the server's next steps are the whole answer; once it
 * is over, the screen leads when it has a subject and the open-ended requests follow.
 */
export const resolveCopilotEmptyState = (
  load: CopilotEmptyStateLoad,
  view: string | null,
  entities: readonly CopilotEntity[],
): ResolvedCopilotEmptyState => {
  // Nothing is shown while loading: on a workspace nothing has happened in, the fixed line is the
  // one thing the operator must never read, and a flash of it before the real copy is still a claim.
  if (load.status === 'loading') return { status: 'pending', greeting: null, showStaticSubtitle: false, chips: [] }
  // Unknown state reads as "nothing has happened": the retrospective line and chips need the server
  // to have said a conversation exists, so a failed read leaves the neutral header and nothing else.
  if (load.status === 'failed') return { status: 'ready', greeting: null, showStaticSubtitle: false, chips: [] }

  const { state } = load
  if (state.phase === 'setup') {
    const chips = state.suggestions.flatMap((suggestion): CopilotEmptyChip[] => {
      if (suggestion.kind === 'prompt') return [{ kind: 'prompt', text: suggestion.text }]
      return isDashboardHref(suggestion.href) ? [{ kind: 'link', text: suggestion.text, href: suggestion.href }] : []
    })
    return { status: 'ready', greeting: state.greeting, showStaticSubtitle: false, chips }
  }

  const requests = state.suggestions.flatMap((suggestion): CopilotEmptyChip[] =>
    suggestion.kind === 'prompt' ? [{ kind: 'prompt', text: suggestion.text }] : [])
  // Retrospective copy and screen-derived chips ("explain what happened in...") are only true once a
  // conversation exists. Setup being over does not say so: closing the first-run takeover ends setup
  // on a workspace nobody has talked to yet.
  const retrospective = state.firstConversationHappened === true
  const hasSubject = entities.some((entity) => entity.focused)
  return {
    status: 'ready',
    greeting: state.greeting,
    showStaticSubtitle: retrospective && state.greeting === null,
    chips: retrospective && (hasSubject || requests.length === 0) ? screenChips(view, entities) : requests,
  }
}
