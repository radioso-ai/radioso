'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'

import { AssistantAvatar } from '@/components/chat/public-chat-bubble-view'
import { copilotApi, type CopilotEmptyState as ServerEmptyState } from '@/lib/api-copilot'
import type { CopilotEntity } from '@/lib/copilot-context'
import {
  requestLocale,
  resolveCopilotEmptyState,
  type CopilotEmptyStateLoad,
} from '@/lib/copilot-empty-state'
import { RAY_AVATAR_URL, RAY_NAME } from '@/lib/ray'

/** The fixed line the panel shows where nothing says the workspace is still being set up. */
const STATIC_SUBTITLE = "Ask me about an agent or conversation and I'll shed some light on what happened."

/**
 * Reads the workspace's empty state once per mount, so each new conversation shows the setup as it
 * stands now. A request that has not answered for the workspace on screen reads as loading.
 */
const useServerEmptyState = (workspaceId: string | null): CopilotEmptyStateLoad => {
  const [outcome, setOutcome] = useState<{ workspaceId: string | null; load: Exclude<CopilotEmptyStateLoad, { status: 'loading' }> } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const locale = requestLocale(typeof navigator === 'undefined' ? undefined : navigator.language)
    copilotApi.getEmptyState(locale, controller.signal)
      .then((state: ServerEmptyState) => setOutcome({ workspaceId, load: { status: 'ready', state } }))
      .catch(() => { if (!controller.signal.aborted) setOutcome({ workspaceId, load: { status: 'failed' } }) })
    return () => controller.abort()
  }, [workspaceId])

  return outcome && outcome.workspaceId === workspaceId ? outcome.load : { status: 'loading' }
}

export function CopilotEmptyState({
  view,
  entities,
  workspaceId,
  onPickPrompt,
  onOpenHref,
}: {
  view: string | null
  entities: readonly CopilotEntity[]
  workspaceId: string | null
  onPickPrompt: (prompt: string) => void
  onOpenHref: (href: string) => void
}) {
  const load = useServerEmptyState(workspaceId)
  const resolved = useMemo(() => resolveCopilotEmptyState(load, view, entities), [entities, load, view])

  return (
    <div className="flex h-full min-h-64 items-center justify-center" data-testid="copilot-empty-state">
      <div className="max-w-md text-center">
        <div className="relative mx-auto flex size-16 items-center justify-center">
          <div className="absolute size-16 rounded-full bg-secondary/15 blur-2xl" aria-hidden />
          <AssistantAvatar avatarUrl={RAY_AVATAR_URL} label={RAY_NAME} className="relative size-12" />
        </div>
        {resolved.greeting ? (
          <p className="mt-4 text-lg font-medium">{resolved.greeting}</p>
        ) : resolved.status === 'pending' ? (
          <div className="mx-auto mt-5 h-5 w-48 animate-pulse rounded bg-muted" aria-hidden />
        ) : (
          <h2 className="mt-4 text-lg font-medium">Hi, I&apos;m Ray ☀️</h2>
        )}
        {resolved.showStaticSubtitle ? <p className="mt-2 text-sm text-muted-foreground">{STATIC_SUBTITLE}</p> : null}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {resolved.chips.map((chip) => (
            <button
              type="button"
              key={`${chip.kind}:${chip.text}`}
              data-testid="copilot-empty-chip"
              className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs hover:border-primary/60 hover:text-primary"
              onClick={() => (chip.kind === 'link' ? onOpenHref(chip.href) : onPickPrompt(chip.text))}
            >
              {chip.text}
              {chip.kind === 'link' ? <ArrowUpRight className="size-3" aria-hidden /> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
