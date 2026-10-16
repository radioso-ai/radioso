'use client'

import { useEffect, useState } from 'react'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { providerDisplayName } from '@/lib/api-llm-providers'
import type { VoiceCallReadiness } from '@/lib/api-types'
import { voiceCallReadinessHint } from '@/lib/voice-call-readiness'

/** `readiness` is the backend's; absent, the page treats voice as not ready and names every piece. */
type Loaded = { offered: boolean; readiness: VoiceCallReadiness | null; vendorName: string }

/**
 * The website widget's switch for voice calls: on, the embed shows Talk while the agent's voice is
 * ready. It saves on its own, so it never rides the widget's debounced settings save. It can be
 * switched on only once voice is ready, and always switched off.
 */
export function WebsiteVoiceCallsSetting({ agentId }: { agentId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    agentsApi.getAgent(agentId).then(
      (agent) => {
        if (!active) return
        setLoaded({
          offered: agent.surfaceSettings.websiteEmbed.voiceCallsOffered,
          readiness: agent.voiceCallReadiness ?? null,
          vendorName: agent.voice.runtime ? providerDisplayName[agent.voice.runtime.vendor] : 'vendor',
        })
      },
      (loadError: unknown) => {
        if (active) setError(getApiErrorMessage(loadError, 'Failed to load the voice call setting.'))
      },
    )
    return () => {
      active = false
    }
  }, [agentId])

  if (!loaded) {
    return error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null
  }

  const save = async (offered: boolean) => {
    setLoaded({ ...loaded, offered })
    setIsSaving(true)
    setError(null)
    try {
      const agent = await agentsApi.updateAgent(agentId, { surfaceSettings: { websiteEmbed: { voiceCallsOffered: offered } } })
      setLoaded((current) => (current ? { ...current, offered: agent.surfaceSettings.websiteEmbed.voiceCallsOffered } : current))
    } catch (saveError) {
      setLoaded((current) => (current ? { ...current, offered: !offered } : current))
      setError(getApiErrorMessage(saveError, 'Failed to save the voice call setting.'))
    } finally {
      setIsSaving(false)
    }
  }

  const { offered, readiness, vendorName } = loaded
  const ready = readiness?.ready === true
  return (
    <div className="mt-5 rounded-xl border border-border bg-background/60 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="websiteEmbedVoiceCalls" className="text-sm font-medium text-foreground">Offer calls on the website</Label>
          <p id="websiteEmbedVoiceCallsHint" className="mt-1 text-xs text-muted-foreground">
            {ready ? 'Visitors see Talk beside Send and can talk to the agent.' : voiceCallReadinessHint(readiness?.missing ?? undefined, vendorName)}
          </p>
        </div>
        <Switch
          id="websiteEmbedVoiceCalls"
          aria-describedby="websiteEmbedVoiceCallsHint"
          checked={offered}
          onCheckedChange={(checked) => void save(checked)}
          disabled={isSaving || (!ready && !offered)}
        />
      </div>
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
    </div>
  )
}
