'use client'

import { useEffect, useState } from 'react'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { llmProvidersApi } from '@/lib/api-llm-providers'
import { voiceCallReadiness, voiceCallReadinessHint, type VoiceCallReadiness } from '@/lib/voice-call-readiness'

type Loaded = { offered: boolean; readiness: VoiceCallReadiness }

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
    Promise.all([
      agentsApi.getAgent(agentId),
      // A teammate who cannot read the stored keys still sees the switch, with every piece named.
      llmProvidersApi.listCredentials().then(
        (list) => list.credentials.map((credential) => credential.provider as string),
        () => null,
      ),
    ]).then(
      ([agent, storedProviders]) => {
        if (!active) return
        setLoaded({
          offered: agent.surfaceSettings.websiteEmbed.voiceCallsOffered,
          readiness: voiceCallReadiness({ voice: agent.voice, storedProviders }),
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

  const { offered, readiness } = loaded
  return (
    <div className="mt-5 rounded-xl border border-border bg-background/60 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="websiteEmbedVoiceCalls" className="text-sm font-medium text-foreground">Offer calls on the website</Label>
          <p id="websiteEmbedVoiceCallsHint" className="mt-1 text-xs text-muted-foreground">
            {readiness.ready ? 'Visitors see Talk beside Send and can talk to the agent.' : voiceCallReadinessHint(readiness)}
          </p>
        </div>
        <Switch
          id="websiteEmbedVoiceCalls"
          aria-describedby="websiteEmbedVoiceCallsHint"
          checked={offered}
          onCheckedChange={(checked) => void save(checked)}
          disabled={isSaving || (!readiness.ready && !offered)}
        />
      </div>
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
    </div>
  )
}
