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
import {
  clearStoredAnonymousSession,
  clearStoredEmbedBootstrapSession,
  readStoredAnonymousSessionId,
  readStoredEmbedBootstrapSession,
  storeEmbedBootstrapSession,
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
  | { status: 'ready'; publicChatToken: string; workspaceName?: string | null }

const READY_MESSAGE = 'radioso:embed:ready'
const SESSION_MESSAGE = 'radioso:embed:session'
const ERROR_MESSAGE = 'radioso:embed:error'

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
  const [state, setState] = useState<BootstrapState>(() => {
    if (typeof window !== 'undefined' && window.parent === window) {
      return {
        status: 'error',
        message: copy.embeddedChatLauncherRequiredMessage,
      }
    }

    const storedSession = typeof window !== 'undefined' ? readStoredEmbedBootstrapSession(token) : null
    return { status: 'bootstrapping', workspaceName: storedSession?.workspaceName ?? null }
  })
  const isBootstrappedRef = useRef(false)

  useEffect(() => {
    if (window.parent === window) {
      return
    }

    let isDisposed = false
    let handshakeInterval: number | null = null
    let handshakeTimeout: number | null = null
    const storedSession = readStoredEmbedBootstrapSession(token)
    const resumeAnonymousSessionId =
      storedSession ? readStoredAnonymousSessionId(storedSession.publicChatToken) : null

    const stopHandshake = () => {
      if (handshakeInterval !== null) {
        window.clearInterval(handshakeInterval)
        handshakeInterval = null
      }

      if (handshakeTimeout !== null) {
        window.clearTimeout(handshakeTimeout)
        handshakeTimeout = null
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
          typeof event.data.session.embedSessionToken === 'string'
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
          embedSessionToken: session.embedSessionToken,
          expiresAt: typeof session.expiresAt === 'string' ? session.expiresAt : new Date(Date.now() + 60_000).toISOString(),
        })
        setState({
          status: 'ready',
          publicChatToken: session.publicChatToken,
          workspaceName: session.workspaceName,
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
    }, 5000)

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

  return (
    <PublicChatShell
      key={`${state.publicChatToken}:${resetNonce}`}
      token={state.publicChatToken}
      initialWorkspaceName={state.workspaceName}
      localeOverride={localeOverride}
      onStartNewChat={handleStartNewChat}
      onRequestCollapse={handleRequestCollapse}
      avatarUrl={avatarUrl}
      copyOverrides={copyOverrides}
      themeOverrides={themeOverrides}
      surface="embed"
    />
  )
}
