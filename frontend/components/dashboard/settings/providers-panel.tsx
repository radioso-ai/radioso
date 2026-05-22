'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Cpu,
  Key,
  MessageSquare,
  RefreshCw,
  ScanSearch,
  Search,
  Sparkles,
} from 'lucide-react'

import { ModelPicker } from '@/components/dashboard/settings/model-picker'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { embeddingModelOptions } from '@/components/dashboard/settings/settings-options'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import { settingsApi } from '@/lib/api'
import type { IngestionSettings } from '@/lib/api-types'
import {
  capabilityDisplayName,
  emptyEnvProviderAvailability,
  llmCapabilityNames,
  llmProviderNames,
  llmProvidersApi,
  providerDisplayName,
  type EnvProviderAvailability,
  type KnownModelsByProvider,
  type LlmCapabilityName,
  type LlmCapabilityPreference,
  type LlmProviderName,
  type ProviderCredentialSummary,
  type WorkspaceLlmModels,
} from '@/lib/api-llm-providers'

type SaveStateValue = 'idle' | 'saving' | 'saved' | 'error'
interface SaveState {
  state: SaveStateValue
  message?: string | null
}

type EmbeddingProviderName = 'openai' | 'gemini'

const embeddingProviderNames: readonly EmbeddingProviderName[] = ['openai', 'gemini']

const embeddingProviderDisplayName: Record<EmbeddingProviderName, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
}

const embeddingProviderForModel = (model: IngestionSettings['embeddingModel']): EmbeddingProviderName =>
  model.startsWith('gemini-') ? 'gemini' : 'openai'

const embeddingModelsByProvider: Record<EmbeddingProviderName, typeof embeddingModelOptions> = {
  openai: embeddingModelOptions.filter((option) => embeddingProviderForModel(option.value) === 'openai'),
  gemini: embeddingModelOptions.filter((option) => embeddingProviderForModel(option.value) === 'gemini'),
}

const modelRowClassName =
  'grid gap-3 sm:grid-cols-[14rem_minmax(12rem,1fr)_minmax(12rem,1fr)_5.5rem] xl:grid-cols-[16rem_minmax(16rem,1fr)_minmax(18rem,1fr)_5.5rem]'

const providerVisual: Record<
  LlmProviderName,
  { monogram: string; tone: string }
> = {
  openai: {
    monogram: 'OA',
    tone: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/30 dark:text-emerald-300',
  },
  claude: {
    monogram: 'AC',
    tone: 'bg-orange-500/10 text-orange-600 ring-orange-500/30 dark:text-orange-300',
  },
  gemini: {
    monogram: 'GG',
    tone: 'bg-sky-500/10 text-sky-600 ring-sky-500/30 dark:text-sky-300',
  },
  'openai-compatible': {
    monogram: 'OC',
    tone: 'bg-slate-500/10 text-slate-600 ring-slate-500/30 dark:text-slate-300',
  },
}

const capabilityVisual: Record<
  LlmCapabilityName | 'embeddings',
  { icon: typeof MessageSquare; description: string }
> = {
  chat: {
    icon: MessageSquare,
    description: 'Generates assistant replies in chat surfaces.',
  },
  rewrite: {
    icon: Sparkles,
    description: 'Rewrites user questions into search queries before retrieval.',
  },
  rerank: {
    icon: ScanSearch,
    description: 'Re-orders retrieved passages by relevance.',
  },
  embeddings: {
    icon: Search,
    description: 'Indexes documents as vectors for semantic search.',
  },
}

export function ProvidersPanel({
  onSaveStateChange,
}: {
  onSaveStateChange?: (state: SaveState) => void
}) {
  const [encryptionConfigured, setEncryptionConfigured] = useState(true)
  const [credentials, setCredentials] = useState<ProviderCredentialSummary[]>([])
  const [envProviderAvailability, setEnvProviderAvailability] =
    useState<EnvProviderAvailability>(emptyEnvProviderAvailability)
  const [models, setModels] = useState<WorkspaceLlmModels | null>(null)
  const [ingestionSettings, setIngestionSettings] = useState<IngestionSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const emitSaveState = useCallback(
    (state: SaveState) => {
      onSaveStateChange?.(state)
    },
    [onSaveStateChange],
  )

  const reloadCredentials = useCallback(async () => {
    const next = await llmProvidersApi.listCredentials()
    setCredentials(next.credentials)
    setEncryptionConfigured(next.encryptionConfigured)
    setEnvProviderAvailability(next.envProviderAvailability)
    return next
  }, [])

  const reloadModels = useCallback(async () => {
    const next = await llmProvidersApi.getModels()
    setModels(next)
    return next
  }, [])

  const reloadIngestionSettings = useCallback(async () => {
    const next = await settingsApi.getIngestionSettings()
    setIngestionSettings(next)
    return next
  }, [])

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [credentialList, modelList, ingestionList] = await Promise.all([
          llmProvidersApi.listCredentials(),
          llmProvidersApi.getModels(),
          settingsApi.getIngestionSettings(),
        ])
        if (!active) return
        setCredentials(credentialList.credentials)
        setEncryptionConfigured(credentialList.encryptionConfigured)
        setEnvProviderAvailability(credentialList.envProviderAvailability)
        setModels(modelList)
        setIngestionSettings(ingestionList)
      } catch (err) {
        if (!active) return
        setError(getApiErrorMessage(err, 'Failed to load provider settings.'))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [])

  if (loading) {
    return (
      <SettingsTabShell>
        <div className="flex justify-center py-8">
          <LogoSpinner />
        </div>
      </SettingsTabShell>
    )
  }

  if (error) {
    return (
      <SettingsTabShell>
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      </SettingsTabShell>
    )
  }

  return (
    <SettingsTabShell>
      <CredentialsCard
        encryptionConfigured={encryptionConfigured}
        credentials={credentials}
        envProviderAvailability={envProviderAvailability}
        onChange={reloadCredentials}
        emitSaveState={emitSaveState}
      />
      {models ? (
        <ModelsCard
          models={models}
          credentials={credentials}
          envProviderAvailability={envProviderAvailability}
          onChange={reloadModels}
          ingestionSettings={ingestionSettings}
          onIngestionSettingsChange={setIngestionSettings}
          onIngestionSettingsReload={reloadIngestionSettings}
          emitSaveState={emitSaveState}
        />
      ) : null}
    </SettingsTabShell>
  )
}

function CredentialsCard({
  encryptionConfigured,
  credentials,
  envProviderAvailability,
  onChange,
  emitSaveState,
}: {
  encryptionConfigured: boolean
  credentials: ProviderCredentialSummary[]
  envProviderAvailability: EnvProviderAvailability
  onChange: () => Promise<unknown>
  emitSaveState: (state: SaveState) => void
}) {
  const [editingProvider, setEditingProvider] = useState<LlmProviderName | null>(null)

  const configuredByProvider = useMemo(() => {
    const map = new Map<LlmProviderName, ProviderCredentialSummary>()
    for (const credential of credentials) {
      map.set(credential.provider, credential)
    }
    return map
  }, [credentials])

  return (
    <SettingsCard
      id="provider-credentials"
      icon={<Key className="h-5 w-5 text-primary" />}
      title="Provider API keys"
      description="Workspace keys are encrypted at rest. They take precedence over deployment-level environment variables when set."
    >
      <div className="space-y-3">
        {!encryptionConfigured ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Server-side secret encryption is not configured. Set <code className="rounded bg-amber-500/20 px-1 py-0.5 font-mono text-[0.8em]">CONNECTOR_ENCRYPTION_KEY</code> on the
              backend to enable workspace API keys; this workspace currently uses the deployment defaults.
            </p>
          </div>
        ) : null}
        <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-background/40">
          {llmProviderNames.map((provider) => (
            <CredentialRow
              key={provider}
              provider={provider}
              configured={configuredByProvider.get(provider) ?? null}
              envAvailable={envProviderAvailability[provider]}
              disabled={!encryptionConfigured}
              editing={editingProvider === provider}
              onStartEditing={() => setEditingProvider(provider)}
              onStopEditing={() => setEditingProvider(null)}
              onChange={onChange}
              emitSaveState={emitSaveState}
            />
          ))}
        </ul>
      </div>
    </SettingsCard>
  )
}

function CredentialRow({
  provider,
  configured,
  envAvailable,
  disabled,
  editing,
  onStartEditing,
  onStopEditing,
  onChange,
  emitSaveState,
}: {
  provider: LlmProviderName
  configured: ProviderCredentialSummary | null
  envAvailable: boolean
  disabled: boolean
  editing: boolean
  onStartEditing: () => void
  onStopEditing: () => void
  onChange: () => Promise<unknown>
  emitSaveState: (state: SaveState) => void
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Closing the editor clears the transient credential draft.
      setDraft('')
    }
  }, [editing])

  const canSubmit = draft.trim().length > 0

  const handleSave = async () => {
    const apiKey = draft.trim()
    if (apiKey.length === 0) return
    setBusy(true)
    emitSaveState({ state: 'saving' })
    try {
      await llmProvidersApi.setCredential(provider, apiKey)
      await onChange()
      emitSaveState({ state: 'saved' })
      setDraft('')
      onStopEditing()
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to save credential.') })
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async () => {
    setBusy(true)
    emitSaveState({ state: 'saving' })
    try {
      await llmProvidersApi.removeCredential(provider)
      await onChange()
      emitSaveState({ state: 'saved' })
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to remove credential.') })
    } finally {
      setBusy(false)
    }
  }

  const visual = providerVisual[provider]
  const status: { label: string; tone: string } = configured
    ? {
        label: 'Workspace key',
        tone: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300',
      }
    : envAvailable
      ? {
          label: 'Deployment key',
          tone: 'bg-sky-500/10 text-sky-700 ring-sky-500/30 dark:text-sky-300',
        }
      : {
          label: 'Not configured',
          tone: 'bg-muted text-muted-foreground ring-border',
        }

  const secondaryHint = configured
    ? `Updated ${new Date(configured.updatedAt).toLocaleString()}`
    : envAvailable
      ? 'Inherits the deployment environment variable.'
      : 'Add a key to use this provider in workspace models.'

  return (
    <li className="flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <div
          aria-hidden="true"
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset text-sm font-semibold ${visual.tone}`}
        >
          {visual.monogram}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">{providerDisplayName[provider]}</p>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${status.tone}`}
            >
              {status.label}
            </span>
          </div>
          {editing ? null : (
            <p className="text-xs text-muted-foreground">{secondaryHint}</p>
          )}
        </div>
      </div>
      {editing ? (
        <div className="flex w-full min-w-0 items-center gap-2 sm:flex-1 sm:justify-end">
          <Input
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void handleSave()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                onStopEditing()
              }
            }}
            placeholder={`${providerDisplayName[provider]} API key`}
            className="min-w-0 flex-1 sm:max-w-sm"
            disabled={busy}
            autoComplete="off"
            autoFocus
          />
          {canSubmit ? (
            <Button type="button" size="sm" onClick={handleSave} disabled={busy}>
              Save
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onStopEditing}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 sm:justify-end">
          <Button
            type="button"
            size="sm"
            variant={configured ? 'outline' : 'default'}
            onClick={onStartEditing}
            disabled={disabled || busy}
          >
            {configured ? 'Replace' : 'Set key'}
          </Button>
          {configured ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={handleRemove}
              disabled={busy}
            >
              Remove
            </Button>
          ) : null}
        </div>
      )}
    </li>
  )
}

function ModelsCard({
  models,
  credentials,
  envProviderAvailability,
  onChange,
  ingestionSettings,
  onIngestionSettingsChange,
  onIngestionSettingsReload,
  emitSaveState,
}: {
  models: WorkspaceLlmModels
  credentials: ProviderCredentialSummary[]
  envProviderAvailability: EnvProviderAvailability
  onChange: () => Promise<unknown>
  ingestionSettings: IngestionSettings | null
  onIngestionSettingsChange: (settings: IngestionSettings) => void
  onIngestionSettingsReload: () => Promise<IngestionSettings>
  emitSaveState: (state: SaveState) => void
}) {
  const credentialProviders = useMemo(
    () => new Set(credentials.map((c) => c.provider)),
    [credentials],
  )
  const availableProviders = useMemo(
    () =>
      new Set(
        llmProviderNames.filter(
          (provider) => credentialProviders.has(provider) || envProviderAvailability[provider],
        ),
      ),
    [credentialProviders, envProviderAvailability],
  )

  return (
    <SettingsCard
      id="provider-models"
      icon={<Cpu className="h-5 w-5 text-primary" />}
      title="Models"
      description="Model assigned to each capability. Chat, rewrite, and rerank fall back to deployment defaults; changing the embedding model re-indexes existing documents."
    >
      <div className="divide-y divide-border/60 rounded-xl border border-border/60 bg-background/40">
        {llmCapabilityNames.map((capability) => {
          const current = models[capability] ?? null
          // Remount the row whenever the persisted preference changes so the
          // editable provider/model fields reset to the new server value.
          const remountKey = `${capability}:${current?.provider ?? ''}:${current?.model ?? ''}`
          return (
            <ModelRow
              key={remountKey}
              capability={capability}
              value={current}
              credentialProviders={credentialProviders}
              availableProviders={availableProviders}
              knownModelsByProvider={models.knownModelsByProvider}
              onChange={onChange}
              emitSaveState={emitSaveState}
            />
          )
        })}
        {ingestionSettings ? (
          <EmbeddingModelRow
            key={`embeddings:${ingestionSettings.embeddingModel}:${ingestionSettings.pendingEmbeddingModel ?? ''}`}
            settings={ingestionSettings}
            onChange={onIngestionSettingsChange}
            onReload={onIngestionSettingsReload}
            emitSaveState={emitSaveState}
          />
        ) : null}
      </div>
    </SettingsCard>
  )
}

function ModelRow({
  capability,
  value,
  credentialProviders,
  availableProviders,
  knownModelsByProvider,
  onChange,
  emitSaveState,
}: {
  capability: LlmCapabilityName
  value: LlmCapabilityPreference | null
  credentialProviders: Set<LlmProviderName>
  availableProviders: Set<LlmProviderName>
  knownModelsByProvider: KnownModelsByProvider
  onChange: () => Promise<unknown>
  emitSaveState: (state: SaveState) => void
}) {
  const [provider, setProvider] = useState<LlmProviderName | ''>(value?.provider ?? '')
  const [model, setModel] = useState(value?.model ?? '')
  const [busy, setBusy] = useState(false)

  const hasValue = value !== null
  const savedProviderUnavailable = value !== null && !availableProviders.has(value.provider)

  const persistModel = async (nextProvider: LlmProviderName, nextModel: string) => {
    setBusy(true)
    emitSaveState({ state: 'saving' })
    try {
      await llmProvidersApi.updateModels({
        [capability]: { provider: nextProvider, model: nextModel.trim() },
      })
      await onChange()
      emitSaveState({ state: 'saved' })
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to save model preference.') })
    } finally {
      setBusy(false)
    }
  }

  const handleProviderChange = (next: string) => {
    setProvider(next as LlmProviderName)
    setModel('')
  }

  const handleModelCommit = (next: string) => {
    const trimmed = next.trim()
    if (provider === '' || trimmed.length === 0) return
    const initialProvider = value?.provider ?? ''
    const initialModel = value?.model ?? ''
    if (provider === initialProvider && trimmed === initialModel) return
    void persistModel(provider, trimmed)
  }

  const handleReset = async () => {
    setBusy(true)
    emitSaveState({ state: 'saving' })
    try {
      await llmProvidersApi.updateModels({ [capability]: null })
      await onChange()
      emitSaveState({ state: 'saved' })
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to clear model preference.') })
    } finally {
      setBusy(false)
    }
  }

  const visual = capabilityVisual[capability]
  const Icon = visual.icon

  return (
    <div
      className={`${modelRowClassName} px-4 py-4`}
      data-testid={`llm-model-row-${capability}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary"
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-medium text-foreground">{capabilityDisplayName[capability]}</p>
            <Badge
              variant={hasValue ? 'default' : 'outline'}
              className={
                hasValue
                  ? 'bg-emerald-500/10 text-emerald-700 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-300'
                  : 'text-muted-foreground'
              }
            >
              {hasValue ? 'Workspace override' : 'Default'}
            </Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{visual.description}</p>
          <p className="sr-only">
            {hasValue ? 'Workspace override' : 'Using deployment default'}
          </p>
        </div>
      </div>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`provider-${capability}`} className="text-xs uppercase tracking-wide text-muted-foreground">
          Provider
        </Label>
        <Select value={provider} onValueChange={handleProviderChange}>
          <SelectTrigger id={`provider-${capability}`} className="w-full min-w-0" disabled={busy}>
            <SelectValue placeholder="Choose provider" />
          </SelectTrigger>
          <SelectContent>
            {llmProviderNames.map((option) => {
              const isAvailable = availableProviders.has(option)
              const suffix = isAvailable
                ? credentialProviders.has(option)
                  ? ''
                  : ' (deployment key)'
                : ' (no key configured)'
              return (
                <SelectItem key={option} value={option} disabled={!isAvailable}>
                  {providerDisplayName[option]}
                  {suffix}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
        {savedProviderUnavailable ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            The saved provider has no API key configured. Add one in Provider API keys above, or reset this row.
          </p>
        ) : null}
      </div>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`model-${capability}`} className="text-xs uppercase tracking-wide text-muted-foreground">
          Model
        </Label>
        <ModelPicker
          inputId={`model-${capability}`}
          provider={provider}
          knownModelsByProvider={knownModelsByProvider}
          value={model}
          onChange={setModel}
          onCommit={handleModelCommit}
          disabled={busy}
          className="w-full min-w-0"
        />
      </div>
      <div className="flex items-end gap-2 sm:justify-end sm:pl-2">
        {hasValue ? (
          <Button type="button" size="sm" variant="ghost" onClick={handleReset} disabled={busy}>
            Reset
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="invisible"
            tabIndex={-1}
            aria-hidden="true"
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  )
}

function EmbeddingModelRow({
  settings,
  onChange,
  onReload,
  emitSaveState,
}: {
  settings: IngestionSettings
  onChange: (settings: IngestionSettings) => void
  onReload: () => Promise<IngestionSettings>
  emitSaveState: (state: SaveState) => void
}) {
  const currentModel = settings.pendingEmbeddingModel ?? settings.embeddingModel
  const [provider, setProvider] = useState<EmbeddingProviderName>(embeddingProviderForModel(currentModel))
  const [model, setModel] = useState<IngestionSettings['embeddingModel']>(currentModel)
  const [busy, setBusy] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [requestedModel, setRequestedModel] = useState<IngestionSettings['embeddingModel'] | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const supportedEmbeddingModels = useMemo(
    () => new Set(settings.supportedEmbeddingModels),
    [settings.supportedEmbeddingModels],
  )
  const providerOptions = useMemo(
    () =>
      embeddingProviderNames.map((option) => ({
        provider: option,
        supported: embeddingModelsByProvider[option].some((modelOption) =>
          supportedEmbeddingModels.has(modelOption.value),
        ),
      })),
    [supportedEmbeddingModels],
  )
  const modelOptions = embeddingModelsByProvider[provider]
  const isPending = Boolean(settings.pendingEmbeddingModel)
  const selectedModelOption = embeddingModelOptions.find((option) => option.value === currentModel)
  const requestedModelOption = requestedModel
    ? embeddingModelOptions.find((option) => option.value === requestedModel)
    : null

  const openConfirmation = (nextModel: IngestionSettings['embeddingModel']) => {
    if (busy || isPending) return
    if (nextModel === currentModel) return
    if (!supportedEmbeddingModels.has(nextModel)) return
    setDialogError(null)
    setRequestedModel(nextModel)
  }

  const handleProviderChange = (nextProvider: string) => {
    const typedProvider = nextProvider as EmbeddingProviderName
    setProvider(typedProvider)
    setDialogError(null)
    const firstSupportedModel = embeddingModelsByProvider[typedProvider]
      .find((option) => supportedEmbeddingModels.has(option.value))
    if (firstSupportedModel) {
      setModel(firstSupportedModel.value)
      openConfirmation(firstSupportedModel.value)
    }
  }

  const handleModelChange = (nextModel: string) => {
    const typed = nextModel as IngestionSettings['embeddingModel']
    setModel(typed)
    setDialogError(null)
    openConfirmation(typed)
  }

  const revertDraft = () => {
    setProvider(embeddingProviderForModel(currentModel))
    setModel(currentModel)
  }

  const handleConfirmModelChange = async () => {
    if (!requestedModel) return
    setBusy(true)
    setDialogError(null)
    emitSaveState({ state: 'saving' })
    try {
      const updated = await settingsApi.updateIngestionSettings({
        ...settings,
        embeddingModel: requestedModel,
      })
      onChange(updated)
      emitSaveState({ state: 'saved' })
      setRequestedModel(null)
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to update the embedding model.') })
      setDialogError(
        getApiErrorMessage(
          err,
          'Failed to complete the embedding model change and start re-indexing. Check the current setting before trying again.',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  const handleCancelPendingModel = async () => {
    setCanceling(true)
    emitSaveState({ state: 'saving' })
    try {
      const updated = await settingsApi.cancelPendingEmbeddingModel()
      onChange(updated)
      emitSaveState({ state: 'saved' })
    } catch (err) {
      await onReload().then(onChange).catch(() => undefined)
      const errorMessage = getApiErrorMessage(err, 'Failed to cancel pending embedding model change.')
      emitSaveState({ state: 'error', message: errorMessage })
    } finally {
      setCanceling(false)
    }
  }

  return (
    <>
      <div
        className={`${modelRowClassName} px-4 py-4`}
        data-testid="llm-model-row-embeddings"
      >
        <div className="flex min-w-0 items-start gap-3">
          <div
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary"
          >
            <Search className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-sm font-medium text-foreground">Embeddings</p>
              <Badge
                variant={isPending ? 'default' : 'outline'}
                className={
                  isPending
                    ? 'bg-amber-500/10 text-amber-700 ring-1 ring-inset ring-amber-500/30 dark:text-amber-300'
                    : 'text-muted-foreground'
                }
              >
                {isPending ? 'Pending re-index' : 'Workspace embedding model'}
              </Badge>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {capabilityVisual.embeddings.description}
            </p>
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor="provider-embeddings" className="text-xs uppercase tracking-wide text-muted-foreground">
            Provider
          </Label>
          <Select value={provider} onValueChange={handleProviderChange} disabled={busy || canceling || isPending}>
            <SelectTrigger id="provider-embeddings" className="w-full min-w-0">
              <SelectValue placeholder="Choose provider" />
            </SelectTrigger>
            <SelectContent>
              {providerOptions.map((option) => (
                <SelectItem key={option.provider} value={option.provider} disabled={!option.supported}>
                  {embeddingProviderDisplayName[option.provider]}
                  {!option.supported ? ' (not configured)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor="model-embeddings" className="text-xs uppercase tracking-wide text-muted-foreground">
            Model
          </Label>
          <Select value={model} onValueChange={handleModelChange} disabled={busy || canceling || isPending}>
            <SelectTrigger id="model-embeddings" className="w-full min-w-0">
              <SelectValue placeholder="Choose model" />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={!supportedEmbeddingModels.has(option.value)}
                >
                  {option.label}
                  {!supportedEmbeddingModels.has(option.value) ? ' (not configured)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-2 sm:justify-end sm:pl-2">
          {isPending ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={handleCancelPendingModel}
              disabled={canceling || busy}
            >
              {canceling ? <Spinner className="mr-2" /> : null}
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="invisible"
              tabIndex={-1}
              aria-hidden="true"
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
      <AlertDialog
        open={requestedModel !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setRequestedModel(null)
            setDialogError(null)
            revertDraft()
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change embedding model?</AlertDialogTitle>
            <AlertDialogDescription>
              Changing from {selectedModelOption?.label ?? currentModel} to {requestedModelOption?.label ?? requestedModel} requires all existing
              documents to be re-indexed. Semantic search keeps using the active model until re-indexing completes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialogError ? <p className="text-sm text-destructive">{dialogError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void handleConfirmModelChange()
              }}
            >
              {busy ? <Spinner className="mr-2" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Change model and re-index
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
