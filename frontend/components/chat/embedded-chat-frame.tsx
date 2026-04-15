'use client'

import { useEffect, useRef, useState } from 'react'

import { AlertCircle } from 'lucide-react'

import { Spinner } from '@/components/ui/spinner'
import { PublicChatShell } from '@/components/chat/public-chat-shell'
import { storeEmbedSessionToken } from '@/lib/api'

function EmbeddedChatUnavailable({ message }: { message: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <AlertCircle className="h-5 w-5 text-muted-foreground" />
      </div>
      <h1 className="text-lg font-medium text-foreground">Embedded Chat Unavailable</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

type BootstrapState =
  | { status: 'bootstrapping' }
  | { status: 'error'; message: string }
  | { status: 'ready'; publicChatToken: string }

const READY_MESSAGE = 'radioso:embed:ready'
const SESSION_MESSAGE = 'radioso:embed:session'
const ERROR_MESSAGE = 'radioso:embed:error'

export function EmbeddedChatFrame({ token }: { token: string }) {
  const [state, setState] = useState<BootstrapState>(() => {
    if (typeof window !== 'undefined' && window.parent === window) {
      return {
        status: 'error',
        message: 'This embedded chat must be opened from the launcher script.',
      }
    }

    return { status: 'bootstrapping' }
  })
  const isBootstrappedRef = useRef(false)

  useEffect(() => {
    if (window.parent === window) {
      return
    }

    let isDisposed = false

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
          typeof event.data.session.publicChatToken === 'string' &&
          typeof event.data.session.embedSessionToken === 'string'
            ? event.data.session
            : null

        if (!session || isDisposed) {
          return
        }

        isBootstrappedRef.current = true
        storeEmbedSessionToken(session.publicChatToken, session.embedSessionToken)
        setState({ status: 'ready', publicChatToken: session.publicChatToken })
        return
      }

      if (event.data.type === ERROR_MESSAGE && !isDisposed) {
        isBootstrappedRef.current = true
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

    const handshakeInterval = window.setInterval(() => {
      window.parent.postMessage({ type: READY_MESSAGE }, '*')
    }, 500)

    window.parent.postMessage({ type: READY_MESSAGE }, '*')

    const handshakeTimeout = window.setTimeout(() => {
      if (!isBootstrappedRef.current && !isDisposed) {
        setState({
          status: 'error',
          message: 'This embedded chat launch could not be verified.',
        })
      }
    }, 5000)

    return () => {
      isDisposed = true
      window.removeEventListener('message', handleMessage)
      window.clearInterval(handshakeInterval)
      window.clearTimeout(handshakeTimeout)
    }
  }, [token])

  if (state.status === 'bootstrapping') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Spinner className="h-6 w-6" />
        <p className="max-w-sm text-sm text-muted-foreground">Starting embedded chat…</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return <EmbeddedChatUnavailable message={state.message} />
  }

  return <PublicChatShell token={state.publicChatToken} />
}
