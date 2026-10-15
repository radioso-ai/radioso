'use client'

import { useEffect, useState } from 'react'
import { AudioLines } from 'lucide-react'

import { AddLanguageField, LanguageGroup, LineListEditor } from '@/components/dashboard/settings/locale-lines-editor'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  VOICE_MAX_LANGUAGES,
  VOICE_MAX_LINE_LENGTH,
  VOICE_MAX_LINES,
  emptyVoiceLanguageLines,
  voiceSettingsFormFromAgent,
  voiceSettingsUpdateFromForm,
  type MechanicsReplyKind,
  type VoiceBridgeStyle,
  type VoiceLanguageLines,
  type VoiceSettingsForm,
} from '@/lib/voice-settings-form'

const BRIDGE_STYLE_LABELS: ReadonlyArray<[VoiceBridgeStyle, string]> = [
  ['check', 'Check'],
  ['acknowledge', 'Acknowledge'],
]
const MECHANICS_REPLY_LABELS: ReadonlyArray<[MechanicsReplyKind, string]> = [
  ['greeting', 'Greeting'],
  ['thanks', 'Thanks'],
  ['farewell', 'Farewell'],
  ['acknowledgement', 'Acknowledgement'],
]

function VoiceLanguageEditor({
  language,
  onChange,
  onRemove,
}: {
  language: VoiceLanguageLines
  onChange: (next: VoiceLanguageLines) => void
  onRemove: () => void
}) {
  const fallbackId = `voiceFallbackLine-${language.locale}`
  return (
    <LanguageGroup locale={language.locale} label="Voice lines" onRemove={onRemove}>
      <div className="space-y-3">
        <div className="space-y-0.5">
          <h4 className="text-sm font-semibold text-foreground">Bridge lines</h4>
          <p className="text-xs text-muted-foreground">
            Write each as one full sentence of at least 45 characters, or ElevenLabs won&rsquo;t speak it before the answer arrives.
          </p>
        </div>
        {BRIDGE_STYLE_LABELS.map(([style, label]) => (
          <LineListEditor
            key={style}
            label={label}
            lines={language.bridgeLines[style]}
            maxLines={VOICE_MAX_LINES}
            maxLength={VOICE_MAX_LINE_LENGTH}
            onChange={(lines) => onChange({ ...language, bridgeLines: { ...language.bridgeLines, [style]: lines } })}
          />
        ))}
        <div className="space-y-2">
          <Label htmlFor={fallbackId} className="text-foreground">Fallback line</Label>
          <Input
            id={fallbackId}
            value={language.fallbackLine}
            maxLength={VOICE_MAX_LINE_LENGTH}
            onChange={(event) => onChange({ ...language, fallbackLine: event.target.value })}
          />
        </div>
      </div>
      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Quick replies</h4>
        {MECHANICS_REPLY_LABELS.map(([kind, label]) => (
          <LineListEditor
            key={kind}
            label={label}
            lines={language.mechanicsReplies[kind]}
            maxLines={VOICE_MAX_LINES}
            maxLength={VOICE_MAX_LINE_LENGTH}
            onChange={(lines) => onChange({ ...language, mechanicsReplies: { ...language.mechanicsReplies, [kind]: lines } })}
          />
        ))}
      </div>
    </LanguageGroup>
  )
}

/** The agent's `voice` and `mechanicsReplies` blocks, saved together and replaced whole. */
export function VoiceChannelCard({ agentId }: { agentId: string }) {
  const [form, setForm] = useState<VoiceSettingsForm | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { saveState, saveError, beginSave, isCurrentSave, markSaved, markError, resetSaveState } = useSettingsSaveStatus()

  useEffect(() => {
    let active = true
    agentsApi.getAgent(agentId).then(
      (agent) => {
        if (active) setForm(voiceSettingsFormFromAgent(agent.voice, agent.mechanicsReplies))
      },
      (error: unknown) => {
        if (active) setLoadError(getApiErrorMessage(error, 'Failed to load voice settings.'))
      },
    )
    return () => {
      active = false
    }
  }, [agentId])

  const edit = (next: VoiceSettingsForm) => {
    setForm(next)
    resetSaveState()
  }

  const save = async (current: VoiceSettingsForm) => {
    const saveId = beginSave()
    try {
      const agent = await agentsApi.updateAgent(agentId, voiceSettingsUpdateFromForm(current))
      if (!isCurrentSave(saveId)) return
      setForm(voiceSettingsFormFromAgent(agent.voice, agent.mechanicsReplies))
      markSaved()
    } catch (error) {
      if (isCurrentSave(saveId)) markError(getApiErrorMessage(error, 'Failed to save voice settings.'))
    }
  }

  return (
    <SettingsCard
      id="voice-channel"
      icon={<AudioLines className="h-5 w-5 text-primary" />}
      title="Voice"
      description="Bridge lines for calls, and word-for-word quick replies on every channel."
    >
      {loadError ? <p className="text-sm text-destructive" role="alert">{loadError}</p> : null}
      {!form && !loadError ? <p className="text-sm text-muted-foreground">Loading voice settings…</p> : null}
      {form ? (
        <div className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="voiceEnabled" className="text-foreground">Voice lines on calls</Label>
            <Switch id="voiceEnabled" checked={form.enabled} onCheckedChange={(enabled) => edit({ ...form, enabled })} />
          </div>
          {form.languages.map((language, index) => (
            <VoiceLanguageEditor
              key={language.locale}
              language={language}
              onChange={(next) => edit({ ...form, languages: form.languages.map((entry, at) => (at === index ? next : entry)) })}
              onRemove={() => edit({ ...form, languages: form.languages.filter((_, at) => at !== index) })}
            />
          ))}
          <AddLanguageField
            id="voiceNewLanguage"
            existingLocales={form.languages.map((language) => language.locale)}
            disabled={form.languages.length >= VOICE_MAX_LANGUAGES}
            onAdd={(locale) => edit({ ...form, languages: [...form.languages, emptyVoiceLanguageLines(locale)] })}
          />
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={() => void save(form)} loading={saveState === 'saving'}>
              Save voice settings
            </Button>
            {saveState === 'saved' ? <span className="text-xs text-muted-foreground">Saved</span> : null}
          </div>
          {saveState === 'error' && saveError ? <p className="text-sm text-destructive" role="alert">{saveError}</p> : null}
        </div>
      ) : null}
    </SettingsCard>
  )
}
