'use client'

import { useEffect, useState } from 'react'

import { externalSkillsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  MCP_OAUTH_PENDING_KEY,
  parseOauthCallbackParams,
  type McpOauthPending,
} from '@/lib/external-skills'

type CallbackState =
  | { kind: 'working' }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

/**
 * Front-end landing page for the MCP OAuth redirect. The provider sends the
 * browser here with `code`/`state`; this page completes the flow against the
 * backend, using the pending connection recorded before the redirect, then asks
 * the author to return to the dashboard tab (which refreshes on focus).
 */
export default function McpOauthCallbackPage() {
  const [state, setState] = useState<CallbackState>({ kind: 'working' })

  useEffect(() => {
    const complete = async () => {
      const params = parseOauthCallbackParams(window.location.search)
      if (!params) {
        setState({ kind: 'error', message: 'Missing authorization code or state in the callback URL.' })
        return
      }
      const pendingRaw = window.localStorage.getItem(MCP_OAUTH_PENDING_KEY)
      if (!pendingRaw) {
        setState({ kind: 'error', message: 'No pending authorization was found. Start the flow again from the agent settings.' })
        return
      }
      let pending: McpOauthPending
      try {
        pending = JSON.parse(pendingRaw) as McpOauthPending
      } catch {
        setState({ kind: 'error', message: 'The pending authorization record was invalid. Start the flow again.' })
        return
      }
      try {
        await externalSkillsApi.completeOauth(pending.agentId, pending.connectionId, params)
        // The opener refreshes on focus; leave the pending key for it to consume.
        setState({ kind: 'done' })
      } catch (error) {
        window.localStorage.removeItem(MCP_OAUTH_PENDING_KEY)
        setState({ kind: 'error', message: getApiErrorMessage(error, 'Could not complete authorization.') })
      }
    }
    void complete()
  }, [])

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
      {state.kind === 'working' ? (
        <>
          <h1 className="text-lg font-medium">Finishing authorization…</h1>
          <p className="text-sm text-muted-foreground">Hold on while we connect the server.</p>
        </>
      ) : null}
      {state.kind === 'done' ? (
        <>
          <h1 className="text-lg font-medium">Connected</h1>
          <p className="text-sm text-muted-foreground">
            Authorization is complete. You can close this tab and return to the agent settings.
          </p>
        </>
      ) : null}
      {state.kind === 'error' ? (
        <>
          <h1 className="text-lg font-medium">Authorization failed</h1>
          <p className="text-sm text-muted-foreground">{state.message}</p>
        </>
      ) : null}
    </main>
  )
}
