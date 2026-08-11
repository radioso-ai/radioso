'use client'

import { useEffect, useMemo, useState } from 'react'
import { UserRound } from 'lucide-react'

import { AssistantLocaleCombobox } from '@/components/dashboard/settings/assistant-locale-combobox'
import { ModelPicker } from '@/components/dashboard/settings/model-picker'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type {
  AgentChatModelOverride,
  AssistantBehaviorSettings,
  GeneralSettings,
} from '@/lib/api'
import {
  emptyEnvProviderAvailability,
  emptyKnownModelsByProvider,
  llmProviderNames,
  llmProvidersApi,
  providerDisplayName,
  type EnvProviderAvailability,
  type KnownModelsByProvider,
  type LlmProviderName,
} from '@/lib/api-llm-providers'

const INSTRUCTION_MAX_LENGTH = 2000

type InstructionPreset = { label: string; text: string }

const INSTRUCTION_PRESETS: InstructionPreset[] = [
  {
    label: 'Helpful & concise',
    text: 'Answer clearly and concisely. Prefer short paragraphs and concrete examples. If you are not sure, say so.',
  },
  {
    label: 'Friendly support',
    text: 'Help visitors solve their problem. Be warm and patient, ask one clarifying question if the request is ambiguous, and link to the most relevant resource.',
  },
  {
    label: 'Sales advisor',
    text: 'Help visitors pick the right option. Ask about their goal, recommend the best fit, and call out any trade-offs honestly.',
  },
]

function BlockHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

function ChatModelOverrideBlock({
  value,
  onChange,
}: {
  value: AgentChatModelOverride | null
  onChange: (next: AgentChatModelOverride | null) => void
}) {
  const provider: LlmProviderName | '' = value?.provider ?? ''
  const model = value?.model ?? ''
  const enabled = value !== null
  const [knownModelsByProvider, setKnownModelsByProvider] = useState<KnownModelsByProvider>(emptyKnownModelsByProvider)
  const [credentialProviders, setCredentialProviders] = useState<Set<LlmProviderName>>(() => new Set())
  const [envProviderAvailability, setEnvProviderAvailability] = useState<EnvProviderAvailability>(
    emptyEnvProviderAvailability,
  )

  useEffect(() => {
    let active = true
    void Promise.all([llmProvidersApi.getModels(), llmProvidersApi.listCredentials()])
      .then(([modelsResponse, credentialsResponse]) => {
        if (!active) return
        setKnownModelsByProvider(modelsResponse.knownModelsByProvider)
        setCredentialProviders(new Set(credentialsResponse.credentials.map((c) => c.provider)))
        setEnvProviderAvailability(credentialsResponse.envProviderAvailability)
      })
      .catch(() => {
        // Falling back to the empty catalog disables the model Select; the agent
        // editor still loads.
      })
    return () => {
      active = false
    }
  }, [])

  const availableProviders = useMemo(
    () =>
      new Set(
        llmProviderNames.filter(
          (option) => credentialProviders.has(option) || envProviderAvailability[option],
        ),
      ),
    [credentialProviders, envProviderAvailability],
  )
  const savedProviderUnavailable = value !== null && !availableProviders.has(value.provider)

  const setProvider = (next: LlmProviderName) => {
    // When the provider changes, drop a stale model from a different vendor so
    // the Select doesn't show a placeholder over an invalid identifier.
    const carriedModel = value?.provider === next ? value.model : ''
    onChange({ provider: next, model: carriedModel })
  }

  const setModel = (next: string) => {
    onChange({ provider: value?.provider ?? 'openai', model: next })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <BlockHeading
          title="Model"
          description="The provider and model behind this agent's chat calls. Leave it empty to follow the workspace default."
        />
        {enabled ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
            Use workspace default
          </Button>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="agentChatProvider" className="text-xs uppercase tracking-wide text-muted-foreground">
            Provider
          </Label>
          <Select value={provider} onValueChange={(next) => setProvider(next as LlmProviderName)}>
            <SelectTrigger id="agentChatProvider">
              <SelectValue placeholder="Use workspace default" />
            </SelectTrigger>
            <SelectContent>
              {llmProviderNames.map((option) => {
                const isAvailable = availableProviders.has(option)
                return (
                  <SelectItem key={option} value={option} disabled={!isAvailable}>
                    {providerDisplayName[option]}
                    {isAvailable ? '' : ' (no key configured)'}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          {savedProviderUnavailable ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              The saved provider has no API key configured. Add one in Providers settings, or clear the override.
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="agentChatModel" className="text-xs uppercase tracking-wide text-muted-foreground">
            Model
          </Label>
          <ModelPicker
            inputId="agentChatModel"
            provider={provider}
            knownModelsByProvider={knownModelsByProvider}
            value={model}
            onChange={(next) => setModel(next.slice(0, 200))}
            disabled={!enabled && model.length === 0}
          />
        </div>
      </div>
    </div>
  )
}

export interface AssistantProfileSectionProps {
  anonSettings: GeneralSettings
  assistantBehaviorSettings: AssistantBehaviorSettings
  assistantLocaleInput: string
  // Operator-only internal label is per-agent; hidden in workspace general settings.
  showInternalName?: boolean
  onAssistantSettingChange: <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => void
  onAssistantLocaleInputChange: (value: string) => void
  onAssistantBehaviorDraft: (updater: (current: AssistantBehaviorSettings) => AssistantBehaviorSettings) => void
  isAnonSaving: boolean
}

export function AssistantProfileSection({
  anonSettings,
  assistantBehaviorSettings,
  assistantLocaleInput,
  showInternalName = false,
  onAssistantSettingChange,
  onAssistantLocaleInputChange,
  onAssistantBehaviorDraft,
  isAnonSaving,
}: AssistantProfileSectionProps) {
  const [pendingPreset, setPendingPreset] = useState<InstructionPreset | null>(null)
  const [presetDraft, setPresetDraft] = useState('')
  const hasPersonaText = assistantBehaviorSettings.customInstruction.trim().length > 0

  const openPreset = (preset: InstructionPreset) => {
    setPendingPreset(preset)
    setPresetDraft(preset.text)
  }

  const closePreset = () => {
    setPendingPreset(null)
  }

  const applyPreset = (mode: 'replace' | 'append') => {
    const draft = presetDraft.slice(0, INSTRUCTION_MAX_LENGTH)
    onAssistantBehaviorDraft((current) => {
      if (mode === 'replace' || current.customInstruction.trim().length === 0) {
        return { ...current, customInstruction: draft }
      }
      const combined = `${current.customInstruction.trimEnd()}\n\n${draft}`.slice(0, INSTRUCTION_MAX_LENGTH)
      return { ...current, customInstruction: combined }
    })
    closePreset()
  }

  return (
    <SettingsCard
      id="assistant-profile"
      icon={<UserRound className="h-5 w-5 text-primary" />}
      title="Profile"
      description="Who this agent is and how it answers by default — its name, its standing instructions, the model behind it, and what every reply carries. For rules that should only apply in specific situations, use Directives."
    >
      <div className="space-y-8">
        <div className="space-y-4">
          <BlockHeading
            title="Name"
            description="What visitors call this agent, and what you call it in the dashboard."
          />
          <div className="space-y-2">
            <Label htmlFor="assistantName" className="text-foreground">Assistant name</Label>
            <Input
              id="assistantName"
              value={anonSettings.assistantName}
              maxLength={200}
              onChange={(event) => onAssistantSettingChange('assistantName', event.target.value)}
              placeholder="e.g. Marta"
            />
            <p className="text-xs text-muted-foreground">
              Shown as the chat title. Falls back to the workspace name when left blank.
            </p>
          </div>

          {showInternalName ? (
            <div className="space-y-2">
              <Label htmlFor="agentInternalName" className="text-foreground">Internal name</Label>
              <Input
                id="agentInternalName"
                value={anonSettings.internalName ?? ''}
                maxLength={200}
                onChange={(event) => onAssistantSettingChange('internalName', event.target.value)}
                placeholder="e.g. Claudio (IT)"
              />
              <p className="text-xs text-muted-foreground">
                Only you see this — it labels the agent in your dashboard to tell look-alikes
                apart. Visitors always see the assistant name above.
              </p>
            </div>
          ) : null}
        </div>

        <div className="space-y-4">
          <BlockHeading
            title="Instructions"
            description="The always-on persona applied to every answer this agent gives."
          />
          <div className="space-y-2">
            <Label htmlFor="assistantAnswerInstruction" className="text-foreground">
              Instructions for the assistant
            </Label>
            {!hasPersonaText ? (
              <div className="flex flex-wrap gap-2">
                {INSTRUCTION_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => openPreset(preset)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            ) : null}
            <Textarea
              id="assistantAnswerInstruction"
              value={assistantBehaviorSettings.customInstruction}
              onChange={(event) =>
                onAssistantBehaviorDraft((current) => ({
                  ...current,
                  customInstruction: event.target.value.slice(0, INSTRUCTION_MAX_LENGTH),
                }))
              }
              placeholder="e.g. Help visitors choose the right course. Be concise, practical, and concrete."
              rows={4}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Sets the purpose, scope, and tone applied to every answer.
                {!hasPersonaText ? ' Pick a preset to start.' : ''}
              </span>
              <span>{assistantBehaviorSettings.customInstruction.length} / {INSTRUCTION_MAX_LENGTH}</span>
            </div>
          </div>
        </div>

        {assistantBehaviorSettings.chatModelOverride !== undefined ? (
          <ChatModelOverrideBlock
            value={assistantBehaviorSettings.chatModelOverride}
            onChange={(next) =>
              onAssistantBehaviorDraft((current) => ({ ...current, chatModelOverride: next }))
            }
          />
        ) : null}

        <div className="space-y-4">
          <BlockHeading
            title="Answers"
            description="What every reply carries, and how a conversation opens."
          />
          <div className="divide-y divide-border rounded-lg border border-border">
            <div className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0">
                <Label htmlFor="citationDisplayEnabled" className="text-foreground">
                  Show source citations
                </Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Show the documents an answer is grounded in on public chat and embeds. Sources appear there but are
                  never clickable — only their links are exposed. Your dashboard chat has its own display toggle.
                </p>
              </div>
              <Switch
                id="citationDisplayEnabled"
                checked={assistantBehaviorSettings.citationDisplayEnabled}
                onCheckedChange={(checked) =>
                  onAssistantBehaviorDraft((current) => ({
                    ...current,
                    citationDisplayEnabled: checked,
                  }))
                }
              />
            </div>
            <div className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0">
                <Label htmlFor="assistantLinkUtmEnabled" className="text-foreground">
                  Assistant link attribution
                </Label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Add Radioso UTM parameters to URLs the assistant includes in answers.
                </p>
              </div>
              <Switch
                id="assistantLinkUtmEnabled"
                checked={assistantBehaviorSettings.assistantLinkUtmEnabled}
                onCheckedChange={(checked) =>
                  onAssistantBehaviorDraft((current) => ({
                    ...current,
                    assistantLinkUtmEnabled: checked,
                  }))
                }
              />
            </div>
            <div className="space-y-3 p-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Label htmlFor="proactiveGreetingEnabled" className="text-foreground">
                    Proactive first greeting
                  </Label>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Whether a brand-new chat opens with an assistant-first greeting.
                  </p>
                </div>
                <Switch
                  id="proactiveGreetingEnabled"
                  checked={anonSettings.proactiveGreetingEnabled}
                  onCheckedChange={(checked) => onAssistantSettingChange('proactiveGreetingEnabled', checked)}
                  disabled={isAnonSaving}
                />
              </div>
              {anonSettings.proactiveGreetingEnabled ? (
                <div className="space-y-2">
                  <Label htmlFor="assistantDefaultLocale" className="text-foreground">Fallback greeting language</Label>
                  <AssistantLocaleCombobox
                    id="assistantDefaultLocale"
                    value={assistantLocaleInput}
                    onChange={onAssistantLocaleInputChange}
                  />
                  <p className="text-xs text-muted-foreground">
                    Used only when we can&apos;t detect the visitor&apos;s language. Replies still follow the visitor&apos;s message.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={pendingPreset !== null} onOpenChange={(open) => { if (!open) closePreset() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingPreset?.label}</DialogTitle>
            <DialogDescription>
              Edit before adding to the assistant&apos;s instructions.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={presetDraft}
            onChange={(event) => setPresetDraft(event.target.value.slice(0, INSTRUCTION_MAX_LENGTH))}
            rows={6}
            aria-label="Preset instructions preview"
          />
          <div className="text-right text-xs text-muted-foreground">
            {presetDraft.length} / {INSTRUCTION_MAX_LENGTH}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closePreset}>Cancel</Button>
            {hasPersonaText ? (
              <>
                <Button variant="outline" onClick={() => applyPreset('append')}>
                  Append to instructions
                </Button>
                <Button onClick={() => applyPreset('replace')}>
                  Replace instructions
                </Button>
              </>
            ) : (
              <Button onClick={() => applyPreset('replace')}>
                Use this preset
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  )
}
