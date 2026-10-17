'use client'

import { useEffect, useState } from 'react'
import { AudioLines } from 'lucide-react'

import { AddLanguageField, LanguageGroup, LineListEditor, LineWarning } from '@/components/dashboard/settings/locale-lines-editor'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { providerDisplayName, voiceVendorNames } from '@/lib/api-llm-providers'
import {
  AGENT_VOICE_SAVED_EVENT,
  ELEVENLABS_MIN_RELEASABLE_SENTENCE_CHARS,
  VOICE_MAX_LANGUAGES,
  VOICE_MAX_LINE_LENGTH,
  VOICE_MAX_LINES,
  VOICE_RUNTIME_AGENT_ID_MAX_LENGTH,
  VOICE_RUNTIME_REGIONS,
  emptyVoiceLanguageLines,
  isBelowElevenLabsSpokenFloor,
  voiceSettingsFormAfterSave,
  voiceSettingsFormFromAgent,
  voiceSettingsUpdateFromForm,
  type MechanicsReplyKind,
  type VoiceBridgeStyle,
  type VoiceLanguageLines,
  type VoiceRuntimeForm,
  type VoiceRuntimeRegion,
  type VoiceSettingsForm,
} from '@/lib/voice-settings-form'

const VOICE_RUNTIME_REGION_LABELS: Record<VoiceRuntimeRegion, string> = {
  us: 'United States (default)',
  eu: 'European Union',
  in: 'India',
  sg: 'Singapore',
}

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
          <p className="text-xs text-muted-foreground">Shown to the caller as a website call starts. Leave it blank to show none.</p>
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

/** The vendor agent a page's voice session opens; the vendor's key lives in workspace Settings. */
function VoiceRuntimeEditor({ runtime, onChange }: { runtime: VoiceRuntimeForm; onChange: (next: VoiceRuntimeForm) => void }) {
  const vendorLabel = providerDisplayName[runtime.vendor]
  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <h4 className="text-sm font-semibold text-foreground">Runtime</h4>
        <p className="text-xs text-muted-foreground">
          Calls open on this {vendorLabel} agent. Add the {vendorLabel} API key under Settings → Providers.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="voiceRuntimeVendor" className="text-foreground">Voice runtime</Label>
          <Select value={runtime.vendor} onValueChange={(value) => onChange({ ...runtime, vendor: voiceVendorNames.find((vendor) => vendor === value) ?? runtime.vendor })}>
            <SelectTrigger id="voiceRuntimeVendor" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {voiceVendorNames.map((vendor) => (
                <SelectItem key={vendor} value={vendor}>{providerDisplayName[vendor]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="voiceRuntimeAgentId" className="text-foreground">{vendorLabel} agent id</Label>
          <Input
            id="voiceRuntimeAgentId"
            value={runtime.agentId}
            maxLength={VOICE_RUNTIME_AGENT_ID_MAX_LENGTH}
            placeholder="agent_…"
            autoComplete="off"
            onChange={(event) => onChange({ ...runtime, agentId: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="voiceRuntimeRegion" className="text-foreground">Data residency</Label>
          <Select value={runtime.region} onValueChange={(value) => onChange({ ...runtime, region: VOICE_RUNTIME_REGIONS.find((region) => region === value) ?? runtime.region })}>
            <SelectTrigger id="voiceRuntimeRegion" className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VOICE_RUNTIME_REGIONS.map((region) => (
                <SelectItem key={region} value={region}>{VOICE_RUNTIME_REGION_LABELS[region]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
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
      description="The vendor agent calls open on, bridge lines for calls, and word-for-word quick replies on every channel."
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
          <VoiceRuntimeEditor runtime={form.runtime} onChange={(runtime) => edit({ ...form, runtime })} />
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
