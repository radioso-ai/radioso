'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { agentVoiceConnectionApi } from '@/lib/api-agent-voice-connection'
import { getApiErrorCode, getApiErrorMessage } from '@/lib/api-error'
import { providerDisplayName } from '@/lib/api-llm-providers'
import type { AgentVoiceConnection } from '@/lib/api-types'
import { useAuth } from '@/lib/auth-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'
import { AGENT_VOICE_SAVED_EVENT, type VoiceRuntimeBinding, type VoiceRuntimeRegion } from '@/lib/voice-settings-form'

/** Where the vendor keeps a call's recording, by the account's data residency region. */
const REGION_LABELS: Record<VoiceRuntimeRegion, string> = {
  us: 'the United States',
  eu: 'the European Union',
  in: 'India',
  sg: 'Singapore',
}

/** What the card says for each way Connect or Disconnect can fail; the API's `error.code` names the way. */
const CONNECT_FAILURES: Record<string, (vendor: string) => string> = {
  voice_vendor_key_missing: (vendor) => `Add your ${vendor} API key under Settings → Providers first.`,
  voice_vendor_key_unreadable: (vendor) => `Radioso can’t read the stored ${vendor} key. Enter it again under Settings → Providers.`,
  voice_vendor_key_rejected: (vendor) => `${vendor} didn’t accept the stored API key. Check the key under Settings → Providers.`,
  voice_vendor_key_lacks_agents_permission: (vendor) =>
    `The ${vendor} key needs the Agents permission, read and write. Turn it on for the key in ${vendor}, or store a key that has it.`,
  voice_vendor_unreachable: (vendor) => `${vendor} didn’t answer. Try again in a moment.`,
  voice_vendor_failed: (vendor) => `${vendor} wouldn’t set up the agent. Try again; if it keeps failing, contact support.`,
  voice_connection_busy: () => 'Another Connect or Disconnect of this agent is still running. Try again in a moment.',
  voice_connection_unavailable: (vendor) =>
    `This deployment has no public API address ${vendor} can reach, so Radioso can’t set up the agent. Ask your administrator to set PUBLIC_API_BASE_URL.`,
}

type Action = 'connect' | 'disconnect'

/**
 * The agent's voice runtime on the Voice card: Connect has Radioso create and maintain the vendor
 * agent on the workspace's own vendor account; Disconnect removes it (or only unbinds one set up
 * outside Radioso). Each answer carries the binding as stored, which the card's form takes over so
 * its next save sends it back unchanged.
 */
export function VoiceRuntimeConnection({
  agentId,
  disabled,
  onRuntimeChange,
  onBusyChange,
}: {
  agentId: string
  /** True while the card saves its form: the binding must not change under the save. */
  disabled: boolean
  onRuntimeChange: (runtime: VoiceRuntimeBinding | null) => void
  onBusyChange: (busy: boolean) => void
}) {
  const { user } = useAuth()
  const { activeWorkspaceId, activeWorkspace } = useWorkspace()
  // Settings → Providers, where the vendor key is stored.
  const providersHref = user
    ? buildDashboardHref(user.accountId, {
      section: 'settings',
      settingsTab: 'providers',
      workspaceId: activeWorkspaceId ?? undefined,
      workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
    })
    : undefined
  const [status, setStatus] = useState<AgentVoiceConnection | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Action | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [vendorAgentLeft, setVendorAgentLeft] = useState(false)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  useEffect(() => {
    let active = true
    agentVoiceConnectionApi.status(agentId).then(
      (loaded) => {
        if (active) setStatus(loaded)
      },
      (error: unknown) => {
        if (active) setLoadError(getApiErrorMessage(error, 'Failed to load the voice runtime.'))
      },
    )
    return () => {
      active = false
    }
  }, [agentId])

  const vendor = providerDisplayName[status?.vendor ?? 'elevenlabs']

  const run = async (action: Action) => {
    setBusy(action)
    onBusyChange(true)
    setActionError(null)
    setVendorAgentLeft(false)
    try {
      let next: AgentVoiceConnection
      if (action === 'connect') {
        next = await agentVoiceConnectionApi.connect(agentId)
      } else {
        const disconnected = await agentVoiceConnectionApi.disconnect(agentId)
        setVendorAgentLeft(disconnected.vendorAgentLeft)
        next = disconnected
      }
      setStatus(next)
      onRuntimeChange(next.runtime)
      window.dispatchEvent(new CustomEvent(AGENT_VOICE_SAVED_EVENT, { detail: { agentId } }))
    } catch (error) {
      const failure = CONNECT_FAILURES[getApiErrorCode(error) ?? '']
      setActionError(failure ? failure(vendor) : getApiErrorMessage(error, action === 'connect' ? `Failed to connect ${vendor}.` : `Failed to disconnect ${vendor}.`))
    } finally {
      setBusy(null)
      onBusyChange(false)
    }
  }

  const keyMissing = status !== null && status.vendorKey !== 'stored'
  const canConnect = status !== null && !keyMissing && status.connectAvailable && !disabled && busy === null

  const connectButton = (label: string, variant?: 'outline') => (
    <Button type="button" size="sm" variant={variant} disabled={!canConnect} loading={busy === 'connect'} onClick={() => void run('connect')}>
      {label}
    </Button>
  )
  const disconnectButton = (
    <Button type="button" size="sm" variant="outline" disabled={disabled || busy !== null} loading={busy === 'disconnect'} onClick={() => setConfirmingDisconnect(true)}>
      Disconnect
    </Button>
  )

  return (
    <div className="space-y-3" data-testid="voice-runtime-connection">
      <div className="space-y-0.5">
        <h4 className="text-sm font-semibold text-foreground">Voice provider</h4>
        <p className="text-xs text-muted-foreground">
          Calls run on your own {vendor} account. Radioso sets up the {vendor} side for this agent and keeps it in step.
        </p>
      </div>
      {loadError ? <p className="text-sm text-destructive" role="alert">{loadError}</p> : null}
      {!status && !loadError ? <p className="text-sm text-muted-foreground">Checking the {vendor} connection…</p> : null}
      {status ? (
        <div className="space-y-3">
          {status.state === 'connected' && status.region ? (
            <p className="text-sm text-foreground">Connected to {vendor} · recordings stay in {REGION_LABELS[status.region]}</p>
          ) : null}
          {status.state === 'connected_externally' ? (
            <p className="text-sm text-foreground">Uses an {vendor} agent set up outside Radioso.</p>
          ) : null}
          {status.state !== 'connected' && keyMissing ? (
            <p className="text-sm text-muted-foreground">
              {status.vendorKey === 'unreadable'
                ? `Radioso can’t read the stored ${vendor} key. Enter it again under `
                : `Add your ${vendor} API key, with the Agents permission, under `}
              {providersHref ? <Link href={providersHref} className="font-medium text-primary underline-offset-4 hover:underline">Settings → Providers</Link> : 'Settings → Providers'}
              {' '}to connect.
            </p>
          ) : null}
          {status.state !== 'connected' && !keyMissing && !status.connectAvailable ? (
            <p className="text-sm text-muted-foreground">
              This deployment has no public API address {vendor} can reach, so Radioso can’t set up the agent. Ask your administrator to set PUBLIC_API_BASE_URL.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {status.state === 'not_connected' ? connectButton(`Connect ${vendor}`) : null}
            {status.state === 'connected_externally' ? connectButton('Let Radioso manage it') : null}
            {/* Connect again repairs: the vendor agent's settings, and a credential that was revoked. */}
            {status.state === 'connected' ? connectButton('Reconnect', 'outline') : null}
            {status.state !== 'not_connected' ? disconnectButton : null}
          </div>
          {vendorAgentLeft ? (
            <p className="text-sm text-muted-foreground" role="status">
              Radioso couldn’t delete the {vendor} agent it created. It can no longer reach this agent; delete it in your {vendor} account.
            </p>
          ) : null}
          {actionError ? <p className="text-sm text-destructive" role="alert">{actionError}</p> : null}
        </div>
      ) : null}
      <AlertDialog open={confirmingDisconnect} onOpenChange={setConfirmingDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {vendor}?</AlertDialogTitle>
            <AlertDialogDescription>
              {status?.state === 'connected'
                ? `Pages can’t start calls with this agent until you connect again. Radioso deletes the ${vendor} agent it created for it.`
                : `Pages can’t start calls with this agent until you connect again. Your ${vendor} agent stays as it is.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmingDisconnect(false)
                void run('disconnect')
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
