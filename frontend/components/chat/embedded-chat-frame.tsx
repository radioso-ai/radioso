'use client'

import { useEffect, useRef, useState } from 'react'

import { AlertCircle } from 'lucide-react'

import { Spinner } from '@/components/ui/spinner'
import { PublicChatShell } from '@/components/chat/public-chat-shell'

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
const HOST_MESSAGE = 'radioso:embed:host'

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

    const bootstrapSession = async (origin: string) => {
      if (isBootstrappedRef.current) {
        return
      }

      isBootstrappedRef.current = true

      try {
        const response = await fetch(`/api/embed/session/${encodeURIComponent(token)}`, {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ origin }),
        })

        const payload = (await response.json().catch(() => null)) as
          | { publicChatToken?: string; error?: { message?: string } }
          | null

        if (!response.ok || !payload?.publicChatToken) {
          const message =
            payload?.error?.message || 'Embedded chat could not be started from this website.'

          if (!isDisposed) {
            setState({ status: 'error', message })
          }
          return
        }

        if (!isDisposed) {
          setState({ status: 'ready', publicChatToken: payload.publicChatToken })
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? `Embedded chat could not be started: ${error.message}`
            : 'Embedded chat could not be started from this website.'

        if (!isDisposed) {
          setState({ status: 'error', message })
        }
      }
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) {
        return
      }

      if (!event.data || typeof event.data !== 'object' || event.data.type !== HOST_MESSAGE) {
        return
      }

      void bootstrapSession(event.origin)
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
