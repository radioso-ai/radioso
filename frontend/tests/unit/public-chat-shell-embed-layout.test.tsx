import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PublicChatShell } from '@/components/chat/public-chat-shell'

const chatState = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/anonymous-chat-context', () => ({
  AnonymousChatProvider: ({ children }: { children: ReactNode }) => children,
  useAnonymousChat: () => chatState.current,
}))

const createChatState = (overrides: Record<string, unknown> = {}) => ({
  publicChatToken: 'public-token',
  messages: [],
  conversationId: undefined,
  workspaceName: 'Vikram',
  assistantAvatarUrl: null,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  assistantTheme: null,
  branding: { hidePoweredBy: false, privacyPolicyUrl: null },
  intakeActions: [],
  isLoading: false,
  isHydrating: false,
  isLoadingOlderMessages: false,
  isUnavailable: false,
  hasOlderMessages: false,
  rateLimitError: null,
  retryAfterSeconds: null,
  loadOlderMessages: vi.fn(),
  sendMessage: vi.fn(),
  startNewChat: vi.fn(),
  trackAnalyticsEvent: vi.fn(),
  ...overrides,
})

const pendingGreetingMessage = {
  id: 'assistant-loading',
  role: 'assistant',
  content: '',
  createdAt: '2026-07-03T10:00:00.000Z',
  status: 'streaming',
}

describe('PublicChatShell embedded layout', () => {
  beforeEach(() => {
    chatState.current = createChatState()
  })

  it('renders a pending embedded greeting inside the normal chat thread', () => {
    chatState.current = createChatState({
      messages: [pendingGreetingMessage],
    })

    const html = renderToStaticMarkup(
      <PublicChatShell
        token="public-token"
        initialWorkspaceName="Vikram"
        surface="embed"
        onRequestCollapse={() => undefined}
        onOpenFullScreen={() => undefined}
      />,
    )

    expect(html).toContain('data-message-role="assistant"')
    expect(html).toMatch(/<h1[^>]*>Vikram<\/h1>/)
    expect(html).not.toMatch(/<h2[^>]*>Vikram<\/h2>/)
  })

  it('renders embedded hydration as a loading first message bubble', () => {
    chatState.current = createChatState({
      isHydrating: true,
    })

    const html = renderToStaticMarkup(
      <PublicChatShell
        token="public-token"
        initialWorkspaceName="Vikram"
        surface="embed"
        onRequestCollapse={() => undefined}
        onOpenFullScreen={() => undefined}
      />,
    )

    expect(html).toContain('data-message-role="assistant"')
    expect(html).toMatch(/<h1[^>]*>Vikram<\/h1>/)
    expect(html).not.toMatch(/<h2[^>]*>Vikram<\/h2>/)
  })

  it('keeps the standalone public chat first screen centered', () => {
    chatState.current = createChatState({
      messages: [pendingGreetingMessage],
    })

    const html = renderToStaticMarkup(
      <PublicChatShell
        token="public-token"
        initialWorkspaceName="Vikram"
        surface="public"
      />,
    )

    expect(html).toMatch(/<h2[^>]*>Vikram<\/h2>/)
    expect(html).not.toContain('data-message-role="assistant"')
  })
})
