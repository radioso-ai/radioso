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
import { useVoiceChannelSwitch } from '@/components/dashboard/settings/use-voice-channel-switch'
import { VoiceVendorKeyDialog } from '@/components/dashboard/settings/voice-vendor-key-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { agentVoiceConnectionApi } from '@/lib/api-agent-voice-connection'
import { getApiErrorMessage } from '@/lib/api-error'
import { providerDisplayName } from '@/lib/api-llm-providers'
import type { AgentVoiceConnection } from '@/lib/api-types'
import { useAuth } from '@/lib/auth-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { useWorkspace } from '@/lib/workspace-context'
import { CONNECT_VOICE_VENDOR, voiceConnectionFailureMessage } from '@/lib/voice-connection-failures'
import { AGENT_VOICE_SAVED_EVENT, type VoiceRuntimeRegion, type VoiceSettingsForm } from '@/lib/voice-settings-form'

/** Where the vendor keeps a call's recording, by the account's data residency region. */
const REGION_LABELS: Record<VoiceRuntimeRegion, string> = {
  us: 'the United States',
  eu: 'the European Union',
  in: 'India',
  sg: 'Singapore',
}

type Action = 'connect' | 'disconnect'

/** The agent's voice as stored, which the card's form takes over so its whole-block save sends it back unchanged. */
type StoredVoice = Pick<VoiceSettingsForm, 'enabled' | 'runtime'>

/**
 * The agent's voice provider on the Voice card. The Voice channel switch saves at once: on, with
 * nothing bound, it has Radioso create and maintain the vendor agent on the workspace's own vendor
 * account, asking for the vendor key in place when needed; off keeps the vendor agent. Reconnect
 * repairs that agent, "Let Radioso manage it" takes over one set up outside Radioso, and Disconnect
 * removes it (or only unbinds one set up outside Radioso). Each answer carries the voice as stored.
 */
export function VoiceRuntimeConnection({
  agentId,
  disabled,
  onVoiceChange,
  onBusyChange,
}: {
  agentId: string
  /** True while the card saves its form: the stored voice must not change under the save. */
  disabled: boolean
  onVoiceChange: (voice: StoredVoice) => void
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

  const take = (next: AgentVoiceConnection) => {
    setStatus(next)
    onVoiceChange({ enabled: next.enabled, runtime: next.runtime })
  }
  const voiceSwitch = useVoiceChannelSwitch({ agentId, vendor: status?.vendor ?? CONNECT_VOICE_VENDOR, onSwitched: take })
  const vendor = providerDisplayName[status?.vendor ?? CONNECT_VOICE_VENDOR]

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
      take(next)
      window.dispatchEvent(new CustomEvent(AGENT_VOICE_SAVED_EVENT, { detail: { agentId } }))
    } catch (error) {
      setActionError(voiceConnectionFailureMessage(error, vendor, action === 'connect' ? `Failed to connect ${vendor}.` : `Failed to disconnect ${vendor}.`))
    } finally {
      setBusy(null)
      onBusyChange(false)
    }
  }

  const switchVoice = async (enabled: boolean) => {
    onBusyChange(true)
    setActionError(null)
    setVendorAgentLeft(false)
    const result = await voiceSwitch.switchChannel(enabled)
    if (!result.switched && result.error) setActionError(result.error)
    onBusyChange(false)
  }

  const idle = !disabled && busy === null && voiceSwitch.pending === null
  const keyMissing = status !== null && status.vendorKey !== 'stored'
  const canConnect = status !== null && !keyMissing && status.connectAvailable && idle
  // An agent stored with voice on but nothing bound takes no calls, so it reads off: turning it on connects.
  const voiceOn = status !== null && status.enabled && status.runtime !== null
  const switchedOn = voiceSwitch.pending ?? voiceOn
  // With nothing bound, turning voice on connects, which needs the vendor to reach this deployment.
  const canTurnOn = status !== null && (status.runtime !== null || status.connectAvailable)

  const connectButton = (label: string, variant?: 'outline') => (
    <Button type="button" size="sm" variant={variant} disabled={!canConnect} loading={busy === 'connect'} onClick={() => void run('connect')}>
      {label}
    </Button>
  )
  const disconnectButton = (
    <Button type="button" size="sm" variant="outline" disabled={!idle} loading={busy === 'disconnect'} onClick={() => setConfirmingDisconnect(true)}>
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
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background/60 p-4">
            <div className="space-y-0.5">
              <Label htmlFor="voiceEnabled" className="text-foreground">Voice channel</Label>
              <p id="voiceEnabledHint" className="text-xs text-muted-foreground">
                Pages can start calls only while it is on.{status.runtime === null ? ` Turning it on connects ${vendor}.` : null}
              </p>
            </div>
            <Switch
              id="voiceEnabled"
              aria-describedby="voiceEnabledHint"
              checked={switchedOn}
              disabled={!idle || (!switchedOn && !canTurnOn)}
              onCheckedChange={(enabled) => void switchVoice(enabled)}
            />
          </div>
          {status.state === 'connected' && status.region ? (
            <p className="text-sm text-foreground">Connected to {vendor} · recordings stay in {REGION_LABELS[status.region]}</p>
          ) : null}
          {status.state === 'connected_externally' ? (
            <p className="text-sm text-foreground">Uses an {vendor} agent set up outside Radioso.</p>
          ) : null}
          {status.state === 'connected_externally' && keyMissing ? (
            <p className="text-sm text-muted-foreground">
              {status.vendorKey === 'unreadable'
                ? `Radioso can’t read the stored ${vendor} key. Enter it again under `
                : `Add your ${vendor} API key, with the Agents permission, under `}
              {providersHref ? <Link href={providersHref} className="font-medium text-primary underline-offset-4 hover:underline">Settings → Providers</Link> : 'Settings → Providers'}
              {' '}to let Radioso manage it.
            </p>
          ) : null}
          {status.state !== 'connected' && !status.connectAvailable && !(status.state === 'connected_externally' && keyMissing) ? (
            <p className="text-sm text-muted-foreground">
              {vendor} can’t reach this Radioso deployment: its address (APP_BASE_URL) isn’t reachable from the internet. Ask your administrator to fix it.
            </p>
          ) : null}
          {status.state !== 'not_connected' ? (
            <div className="flex flex-wrap items-center gap-2">
              {status.state === 'connected_externally' ? connectButton('Let Radioso manage it') : null}
              {/* Connect again repairs: the vendor agent's settings, and a credential that was revoked. */}
              {status.state === 'connected' ? connectButton('Reconnect', 'outline') : null}
              {disconnectButton}
            </div>
          ) : null}
          {vendorAgentLeft ? (
            <p className="text-sm text-muted-foreground" role="status">
              Radioso couldn’t delete the {vendor} agent it created. It can no longer reach this agent; delete it in your {vendor} account.
            </p>
          ) : null}
          {actionError ? <p className="text-sm text-destructive" role="alert">{actionError}</p> : null}
        </div>
      ) : null}
      <VoiceVendorKeyDialog {...voiceSwitch.keyDialog} />
      <AlertDialog open={confirmingDisconnect} onOpenChange={setConfirmingDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {vendor}?</AlertDialogTitle>
            <AlertDialogDescription>
              {status?.state === 'connected'
                ? `Pages can’t start calls with this agent until you turn its voice channel on again. Radioso deletes the ${vendor} agent it created for it.`
                : `Pages can’t start calls with this agent until you turn its voice channel on again. Your ${vendor} agent stays as it is.`}
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
