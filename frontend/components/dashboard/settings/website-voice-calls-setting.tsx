'use client'

import { useEffect, useState } from 'react'

import { useVoiceChannelSwitch } from '@/components/dashboard/settings/use-voice-channel-switch'
import { VoiceVendorKeyDialog } from '@/components/dashboard/settings/voice-vendor-key-dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { providerDisplayName, type VoiceVendorName } from '@/lib/api-llm-providers'
import type { VoiceCallReadiness } from '@/lib/api-types'
import { onVoiceCallReadinessChange, websiteCallsSwitchOf } from '@/lib/voice-call-readiness'
import { CONNECT_VOICE_VENDOR } from '@/lib/voice-connection-failures'

/** `readiness` is the backend's; absent, the page treats voice as not ready. `vendor` is the bound runtime's, else the one turning voice on connects. */
type Loaded = { offered: boolean; readiness: VoiceCallReadiness | null; vendor: VoiceVendorName }

/**
 * The website widget's switch for voice calls: on, the embed shows Talk while the agent's voice is
 * ready. It saves on its own, so it never rides the widget's debounced settings save. When voice is
 * not ready yet but the missing piece is one it can set up (the voice channel, its runtime or the
 * vendor key), turning it on turns the agent's voice on first, asking for the vendor key in place,
 * and offers calls only once that worked. Otherwise it can be switched on only once voice is ready,
 * and always switched off. Readiness is read again whenever the agent's voice may have changed.
 */
export function WebsiteVoiceCallsSetting({ agentId }: { agentId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const voiceSwitch = useVoiceChannelSwitch({ agentId, vendor: loaded?.vendor ?? CONNECT_VOICE_VENDOR })

  useEffect(() => {
    let active = true
    let firstLoad = true
    const load = () => {
      agentsApi.getAgent(agentId).then(
        (agent) => {
          if (!active) return
          const readiness = agent.voiceCallReadiness ?? null
          const vendor = agent.voice.runtime?.vendor ?? CONNECT_VOICE_VENDOR
          // The switch's own value is this card's after the first read; a refresh brings readiness.
          setLoaded((current) => (current
            ? { ...current, readiness, vendor }
            : { offered: agent.surfaceSettings.websiteEmbed.voiceCallsOffered, readiness, vendor }))
        },
        (loadError: unknown) => {
          if (active && firstLoad) setError(getApiErrorMessage(loadError, 'Failed to load the voice call setting.'))
        },
      ).finally(() => {
        firstLoad = false
      })
    }
    load()
    const stopReading = onVoiceCallReadinessChange(agentId, load)
    return () => {
      active = false
      stopReading()
    }
  }, [agentId])

  if (!loaded) {
    return error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null
  }

  const { offered, readiness, vendor } = loaded
  const calls = websiteCallsSwitchOf(readiness, providerDisplayName[vendor])
  const settingUpVoice = voiceSwitch.pending !== null

  const save = async (next: boolean) => {
    setLoaded((current) => (current ? { ...current, offered: next } : current))
    setIsSaving(true)
    try {
      const agent = await agentsApi.updateAgent(agentId, { surfaceSettings: { websiteEmbed: { voiceCallsOffered: next } } })
      setLoaded((current) => (current ? { ...current, offered: agent.surfaceSettings.websiteEmbed.voiceCallsOffered } : current))
    } catch (saveError) {
      setLoaded((current) => (current ? { ...current, offered: !next } : current))
      setError(getApiErrorMessage(saveError, 'Failed to save the voice call setting.'))
    } finally {
      setIsSaving(false)
    }
  }

  const change = async (next: boolean) => {
    setError(null)
    if (next && calls.kind === 'sets_up_voice') {
      const result = await voiceSwitch.switchChannel(true)
      if (!result.switched) {
        setError(result.error)
        return
      }
    }
    await save(next)
  }

  return (
    <div className="mt-5 rounded-xl border border-border bg-background/60 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="websiteEmbedVoiceCalls" className="text-sm font-medium text-foreground">Offer calls on the website</Label>
          <p id="websiteEmbedVoiceCallsHint" className="mt-1 text-xs text-muted-foreground">
            {calls.kind === 'ready' ? 'Visitors see Talk beside Send and can talk to the agent.' : calls.hint}
          </p>
        </div>
        <Switch
          id="websiteEmbedVoiceCalls"
          aria-describedby="websiteEmbedVoiceCallsHint"
          checked={offered || settingUpVoice}
          onCheckedChange={(checked) => void change(checked)}
          disabled={isSaving || settingUpVoice || (calls.kind === 'blocked' && !offered)}
        />
      </div>
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
      <VoiceVendorKeyDialog {...voiceSwitch.keyDialog} />
    </div>
  )
}
