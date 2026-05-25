'use client'

import { useEffect, useRef, useState } from 'react'

import { AlertCircle } from 'lucide-react'

import { PublicChatShell } from '@/components/chat/public-chat-shell'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  formatWebsiteEmbedStartingMessage,
  getWebsiteEmbedCopy,
  getWebsiteEmbedTheme,
  type WebsiteEmbedCopyOverrides,
  type WebsiteEmbedThemeOverrides,
} from '@/lib/embed-widget'
import { buildPublicChatSessionHandoffHash } from '@/lib/public-chat-session-handoff'
import {
  clearStoredAnonymousSession,
  clearStoredEmbedBootstrapSession,
  readStoredAnonymousSessionId,
  readStoredEmbedBootstrapSession,
  storeEmbedBootstrapSession,
  type WebsiteEmbedPageContext,
} from '@/lib/api'

function EmbeddedChatUnavailable({
  localeOverride,
  message,
  copyOverrides,
  themeOverrides,
}: {
  localeOverride?: string | null
  message: string
  copyOverrides?: WebsiteEmbedCopyOverrides | null
  themeOverrides?: WebsiteEmbedThemeOverrides | null
}) {
  const copy = getWebsiteEmbedCopy(localeOverride, copyOverrides)
  const theme = getWebsiteEmbedTheme(themeOverrides)

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 text-center" style={{ color: theme.panelForeground }}>
      <div
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-full"
        style={{ background: theme.mutedBackground }}
      >
        <AlertCircle className="h-5 w-5" style={{ color: theme.mutedForeground }} />
      </div>
      <h1 className="text-lg font-medium">{copy.embeddedChatUnavailableTitle}</h1>
      <p className="mt-1 max-w-sm text-sm" style={{ color: theme.mutedForeground }}>{message}</p>
    </div>
  )
}

type BootstrapState =
  | { status: 'bootstrapping'; workspaceName?: string | null }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      publicChatToken: string
      publicSessionId: string
      publicSessionToken: string
      expiresAt: string
      workspaceName?: string | null
      pageContext?: WebsiteEmbedPageContext | null
    }

const READY_MESSAGE = 'radioso:embed:ready'
const SESSION_MESSAGE = 'radioso:embed:session'
const ERROR_MESSAGE = 'radioso:embed:error'
const HANDSHAKE_TIMEOUT_MS = 30_000
const FULLSCREEN_MESSAGE = 'radioso:embed:fullscreen'

const sanitizePageContext = (value: unknown): WebsiteEmbedPageContext | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  const input = value as Record<string, unknown>
  const pick = (key: string, maxLength: number) => {
    const raw = input[key]
    if (typeof raw !== 'string') {
      return null
    }

    const trimmed = raw.trim()
    return trimmed ? trimmed.slice(0, maxLength) : null
  }

  const pageContext: WebsiteEmbedPageContext = {
    pageUrl: pick('pageUrl', 2048),
    pageTitle: pick('pageTitle', 180),
    pageLocale: pick('pageLocale', 35),
    browserLocale: pick('browserLocale', 35),
    content: pick('content', 6000),
  }

  return Object.values(pageContext).some(Boolean) ? pageContext : null
}

export function EmbeddedChatFrame({
  token,
  localeOverride,
  avatarUrl,
  copyOverrides,
  themeOverrides,
}: {
  token: string
  localeOverride?: string | null
  displayMode?: string | null
  avatarUrl?: string | null
  copyOverrides?: WebsiteEmbedCopyOverrides | null
  themeOverrides?: WebsiteEmbedThemeOverrides | null
}) {
  const copy = getWebsiteEmbedCopy(localeOverride, copyOverrides)
  const theme = getWebsiteEmbedTheme(themeOverrides)
  const [resetNonce, setResetNonce] = useState(0)
  // Initialize without reading sessionStorage: SSR has no access to it, and the
  // mount-time effect below hydrates workspaceName from the stored session.
  // Reading here causes a server/client text mismatch on the bootstrapping screen.
  const [state, setState] = useState<BootstrapState>({ status: 'bootstrapping', workspaceName: null })
  const isBootstrappedRef = useRef(false)

  useEffect(() => {
    if (window.parent === window) {
      const errorTimer = window.setTimeout(() => {
        setState({ status: 'error', message: copy.embeddedChatLauncherRequiredMessage })
      }, 0)
      return () => window.clearTimeout(errorTimer)
    }

    let isDisposed = false
    let handshakeInterval: number | null = null
    let handshakeTimeout: number | null = null
    let storedWorkspaceNameTimer: number | null = null
    const storedSession = readStoredEmbedBootstrapSession(token)
    const resumeAnonymousSessionId =
      storedSession ? readStoredAnonymousSessionId(storedSession.publicChatToken) : null

    if (storedSession?.workspaceName) {
      storedWorkspaceNameTimer = window.setTimeout(() => {
        setState((current) =>
          current.status === 'bootstrapping'
            ? { ...current, workspaceName: storedSession.workspaceName }
            : current,
        )
      }, 0)
    }

    const stopHandshake = () => {
      if (handshakeInterval !== null) {
        window.clearInterval(handshakeInterval)
        handshakeInterval = null
      }

      if (handshakeTimeout !== null) {
        window.clearTimeout(handshakeTimeout)
        handshakeTimeout = null
      }

      if (storedWorkspaceNameTimer !== null) {
        window.clearTimeout(storedWorkspaceNameTimer)
        storedWorkspaceNameTimer = null
      }
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) {
        return
      }

      if (!event.data || typeof event.data !== 'object') {
        return
      }

      if (event.data.type === SESSION_MESSAGE) {
        const session =
          event.data.session &&
          typeof event.data.session === 'object' &&
          typeof event.data.session.workspaceName === 'string' &&
          typeof event.data.session.publicChatToken === 'string' &&
          typeof event.data.session.publicSessionId === 'string' &&
          typeof event.data.session.publicSessionToken === 'string'
            ? event.data.session
            : null

        if (!session || isDisposed) {
          return
        }

        isBootstrappedRef.current = true
        stopHandshake()
        storeEmbedBootstrapSession(token, {
          workspaceName: session.workspaceName,
          publicChatToken: session.publicChatToken,
          publicSessionId: session.publicSessionId,
          publicSessionToken: session.publicSessionToken,
          expiresAt: typeof session.expiresAt === 'string' ? session.expiresAt : new Date(Date.now() + 60_000).toISOString(),
        })
        const expiresAt = typeof session.expiresAt === 'string' ? session.expiresAt : new Date(Date.now() + 60_000).toISOString()
        setState({
          status: 'ready',
          publicChatToken: session.publicChatToken,
          publicSessionId: session.publicSessionId,
          publicSessionToken: session.publicSessionToken,
          expiresAt,
          workspaceName: session.workspaceName,
          pageContext: sanitizePageContext(event.data.pageContext),
        })
        return
      }

      if (event.data.type === ERROR_MESSAGE && !isDisposed) {
        isBootstrappedRef.current = true
        stopHandshake()
        setState({
          status: 'error',
          message:
            typeof event.data.message === 'string'
              ? event.data.message
              : 'Embedded chat could not be started from this website.',
        })
      }
    }

    window.addEventListener('message', handleMessage)

    handshakeInterval = window.setInterval(() => {
      window.parent.postMessage(
        { type: READY_MESSAGE, resumeAnonymousSessionId },
        '*',
      )
    }, 500)

    window.parent.postMessage(
      { type: READY_MESSAGE, resumeAnonymousSessionId },
      '*',
    )

    handshakeTimeout = window.setTimeout(() => {
      if (!isBootstrappedRef.current && !isDisposed) {
        setState({
          status: 'error',
          message: 'This embedded chat launch could not be verified.',
        })
      }
    }, HANDSHAKE_TIMEOUT_MS)

    return () => {
      isDisposed = true
      stopHandshake()
      window.removeEventListener('message', handleMessage)
    }
  }, [copy.embeddedChatLauncherRequiredMessage, resetNonce, token])

  if (state.status === 'bootstrapping') {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        style={{ color: theme.panelForeground }}
      >
        <LogoSpinner imageClassName="h-7 w-7" />
        <p className="max-w-sm text-sm" style={{ color: theme.mutedForeground }}>
          {formatWebsiteEmbedStartingMessage({
            embeddedChatStartingMessage: copy.embeddedChatStartingMessage,
            embeddedChatTitle: state.workspaceName?.trim() || copy.embeddedChatTitle,
          })}
        </p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <EmbeddedChatUnavailable
        localeOverride={localeOverride}
        message={state.message}
        copyOverrides={copyOverrides}
        themeOverrides={themeOverrides}
      />
    )
  }

  const handleStartNewChat = async () => {
    clearStoredAnonymousSession(state.publicChatToken)
    clearStoredEmbedBootstrapSession(token)
    isBootstrappedRef.current = false
    setState({ status: 'bootstrapping', workspaceName: state.workspaceName ?? null })
    setResetNonce((current) => current + 1)
  }

  const handleRequestCollapse = () => {
    if (typeof window !== 'undefined' && window.parent !== window) {
      window.parent.postMessage({ type: 'radioso:embed:collapse' }, '*')
    }
  }

  const handleOpenFullScreen = () => {
    if (typeof window !== 'undefined' && window.parent !== window) {
      window.parent.postMessage({ type: FULLSCREEN_MESSAGE }, '*')
    }
  }

  const handleOpenNewTab = () => {
    if (typeof window === 'undefined') {
      return
    }

    const url = new URL(`/chat/${encodeURIComponent(state.publicChatToken)}`, window.location.origin)
    if (localeOverride) {
      url.searchParams.set('locale', localeOverride)
    }
    if (copyOverrides && Object.keys(copyOverrides).length > 0) {
      url.searchParams.set('copy', JSON.stringify(copyOverrides))
    }
    if (themeOverrides && Object.keys(themeOverrides).length > 0) {
      url.searchParams.set('theme', JSON.stringify(themeOverrides))
    }

    url.hash = buildPublicChatSessionHandoffHash({
      publicSessionId: state.publicSessionId,
      publicSessionToken: state.publicSessionToken,
      expiresAt: state.expiresAt,
    })
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  return (
    <PublicChatShell
      key={`${state.publicChatToken}:${resetNonce}`}
      token={state.publicChatToken}
      initialWorkspaceName={state.workspaceName}
      localeOverride={localeOverride}
      onStartNewChat={handleStartNewChat}
      onRequestCollapse={handleRequestCollapse}
      onOpenFullScreen={handleOpenFullScreen}
      onOpenNewTab={handleOpenNewTab}
      avatarUrl={avatarUrl}
      copyOverrides={copyOverrides}
      themeOverrides={themeOverrides}
      surface="embed"
      pageContext={state.pageContext}
    />
  )
}
