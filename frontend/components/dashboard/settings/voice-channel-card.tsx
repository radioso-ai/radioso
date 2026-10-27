'use client'

import { useEffect, useState } from 'react'
import { AudioLines } from 'lucide-react'

import { AddLanguageField, LanguageGroup, LineListEditor, LineWarning } from '@/components/dashboard/settings/locale-lines-editor'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { VoiceRuntimeConnection } from '@/components/dashboard/settings/voice-runtime-connection'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  AGENT_VOICE_SAVED_EVENT,
  ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS,
  VOICE_MAX_LANGUAGES,
  VOICE_MAX_LINE_LENGTH,
  VOICE_MAX_LINES,
  emptyVoiceLanguageLines,
  isBelowElevenLabsSpokenFloor,
  voiceSettingsFormAfterSave,
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

/** Warns without blocking: only the `elevenlabs` dialect has a first-sentence floor. */
const spokenFloorWarning = (line: string): string | null =>
  isBelowElevenLabsSpokenFloor(line)
    ? `Shorter than ${ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS} characters: ElevenLabs will not speak it before the answer.`
    : null

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
  const noticeId = `voiceRecordingNotice-${language.locale}`

  return (
    <LanguageGroup locale={language.locale} label="Voice lines" onRemove={onRemove}>
      <div className="space-y-3">
        <div className="space-y-0.5">
          <h4 className="text-sm font-semibold text-foreground">Bridge lines</h4>
          <p className="text-xs text-muted-foreground">
            Write each bridge line and the fallback line as one full sentence of at least {ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS} characters, or ElevenLabs won&rsquo;t speak it before the answer arrives.
          </p>
        </div>
        {BRIDGE_STYLE_LABELS.map(([style, label]) => (
          <LineListEditor
            key={style}
            label={label}
            lines={language.bridgeLines[style]}
            maxLines={VOICE_MAX_LINES}
            maxLength={VOICE_MAX_LINE_LENGTH}
            lineWarning={spokenFloorWarning}
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
          <LineWarning text={spokenFloorWarning(language.fallbackLine)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor={noticeId} className="text-foreground">Recording notice</Label>
          <p className="text-xs text-muted-foreground">Shown to the caller as a website call starts, and said before the greeting when Radioso manages the voice agent. Leave it blank for none.</p>
          <Input
            id={noticeId}
            value={language.recordingNotice}
            maxLength={VOICE_MAX_LINE_LENGTH}
            placeholder="This call is recorded."
            onChange={(event) => onChange({ ...language, recordingNotice: event.target.value })}
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

/**
 * The agent's `voice` and `mechanicsReplies` blocks, saved together and replaced whole. Render it
 * keyed by `agentId`: a save replaces both blocks, so one agent's form must never outlive a switch
 * to another agent.
 */
export function VoiceChannelCard({ agentId }: { agentId: string }) {
  const [form, setForm] = useState<VoiceSettingsForm | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // While Connect or Disconnect runs, a save would send the binding it is about to replace.
  const [runtimeBusy, setRuntimeBusy] = useState(false)
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
      setForm(voiceSettingsFormAfterSave(current, agent.voice, agent.mechanicsReplies))
      markSaved()
      window.dispatchEvent(new CustomEvent(AGENT_VOICE_SAVED_EVENT, { detail: { agentId } }))
    } catch (error) {
      if (isCurrentSave(saveId)) markError(getApiErrorMessage(error, 'Failed to save voice settings.'))
    }
  }

  return (
    <SettingsCard
      id="voice-channel"
      icon={<AudioLines className="h-5 w-5 text-primary" />}
      title="Voice"
      description="Let visitors talk to this agent out loud, and write the lines it says word for word."
    >
      {loadError ? <p className="text-sm text-destructive" role="alert">{loadError}</p> : null}
      {!form && !loadError ? <p className="text-sm text-muted-foreground">Loading voice settings…</p> : null}
      {form ? (
        <div className="space-y-5">
          {/* Edits typed while a save is in flight would be replaced by its response, so the editors wait for it. */}
          <fieldset disabled={saveState === 'saving'} className="min-w-0 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="voiceEnabled" className="text-foreground">Voice channel</Label>
              <p id="voiceEnabledHint" className="text-xs text-muted-foreground">Lets pages start calls, and calls hear the lines below.</p>
            </div>
            <Switch id="voiceEnabled" aria-describedby="voiceEnabledHint" checked={form.enabled} onCheckedChange={(enabled) => edit({ ...form, enabled })} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="voiceLanguageSwitching" className="text-foreground">Switch language with the caller</Label>
              <p id="voiceLanguageSwitchingHint" className="text-xs text-muted-foreground">
                A call switches its voice and transcription to the caller&rsquo;s language.
              </p>
            </div>
            <Switch
              id="voiceLanguageSwitching"
              aria-describedby="voiceLanguageSwitchingHint"
              checked={form.languageSwitching}
              onCheckedChange={(languageSwitching) => edit({ ...form, languageSwitching })}
            />
          </div>
          <VoiceRuntimeConnection
            agentId={agentId}
            disabled={saveState === 'saving'}
            // The binding is already stored; the form takes it over so its next save keeps it.
            onRuntimeChange={(runtime) => setForm((current) => (current ? { ...current, runtime } : current))}
            onBusyChange={setRuntimeBusy}
          />
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
            maxLanguages={VOICE_MAX_LANGUAGES}
            onAdd={(locale) => edit({ ...form, languages: [...form.languages, emptyVoiceLanguageLines(locale)] })}
          />
          </fieldset>
          <div className="flex items-center gap-3">
            <Button type="button" size="sm" onClick={() => void save(form)} loading={saveState === 'saving'} disabled={runtimeBusy}>
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
