'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Cpu, Key } from 'lucide-react'

import { ModelPicker } from '@/components/dashboard/settings/model-picker'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
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
import { LogoSpinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
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

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [credentialList, modelList] = await Promise.all([
          llmProvidersApi.listCredentials(),
          llmProvidersApi.getModels(),
        ])
        if (!active) return
        setCredentials(credentialList.credentials)
        setEncryptionConfigured(credentialList.encryptionConfigured)
        setEnvProviderAvailability(credentialList.envProviderAvailability)
        setModels(modelList)
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
        onChange={reloadCredentials}
        emitSaveState={emitSaveState}
      />
      {models ? (
        <ModelsCard
          models={models}
          credentials={credentials}
          envProviderAvailability={envProviderAvailability}
          onChange={reloadModels}
          emitSaveState={emitSaveState}
        />
      ) : null}
    </SettingsTabShell>
  )
}

function CredentialsCard({
  encryptionConfigured,
  credentials,
  onChange,
  emitSaveState,
}: {
  encryptionConfigured: boolean
  credentials: ProviderCredentialSummary[]
  onChange: () => Promise<unknown>
  emitSaveState: (state: SaveState) => void
}) {
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
      description="Workspace API keys are encrypted at rest. They override the deployment-level environment variables when set."
    >
      <div className="space-y-3">
        {!encryptionConfigured ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            Server-side secret encryption is not configured. Set <code>CONNECTOR_ENCRYPTION_KEY</code> on the
            backend to enable workspace API keys; this workspace currently uses the deployment defaults.
          </div>
        ) : null}
        <ul className="divide-y divide-border rounded-md border border-border">
          {llmProviderNames.map((provider) => (
            <CredentialRow
              key={provider}
              provider={provider}
              configured={configuredByProvider.get(provider) ?? null}
              disabled={!encryptionConfigured}
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
  disabled,
  onChange,
  emitSaveState,
}: {
  provider: LlmProviderName
  configured: ProviderCredentialSummary | null
  disabled: boolean
  onChange: () => Promise<unknown>
  emitSaveState: (state: SaveState) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

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
      setEditing(false)
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

  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium text-foreground">{providerDisplayName[provider]}</p>
        <p className="text-xs text-muted-foreground">
          {configured
            ? `Configured · updated ${new Date(configured.updatedAt).toLocaleString()}`
            : 'Not configured — using the deployment environment variable when set.'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Input
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={`${providerDisplayName[provider]} API key`}
              className="min-w-[18rem]"
              disabled={busy}
              autoComplete="off"
            />
            <Button type="button" size="sm" onClick={handleSave} disabled={busy || draft.trim().length === 0}>
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false)
                setDraft('')
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
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
          </>
        )}
      </div>
    </li>
  )
}

function ModelsCard({
  models,
  credentials,
  envProviderAvailability,
  onChange,
  emitSaveState,
}: {
  models: WorkspaceLlmModels
  credentials: ProviderCredentialSummary[]
  envProviderAvailability: EnvProviderAvailability
  onChange: () => Promise<unknown>
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
      description="Per-capability provider and model selection. Empty rows fall back to the deployment defaults. The chat model can also be overridden per agent."
    >
      <div className="space-y-4">
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

  const dirty = useMemo(() => {
    const initialProvider = value?.provider ?? ''
    const initialModel = value?.model ?? ''
    return provider !== initialProvider || model !== initialModel
  }, [provider, model, value])

  const canSave = provider !== '' && model.trim().length > 0 && dirty
  const hasValue = value !== null
  const savedProviderUnavailable = value !== null && !availableProviders.has(value.provider)

  const handleSave = async () => {
    if (!canSave || !provider) return
    setBusy(true)
    emitSaveState({ state: 'saving' })
    try {
      await llmProvidersApi.updateModels({ [capability]: { provider, model: model.trim() } })
      await onChange()
      emitSaveState({ state: 'saved' })
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to save model preference.') })
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
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

  return (
    <div
      className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_minmax(0,1fr)_auto]"
      data-testid={`llm-model-row-${capability}`}
    >
      <div className="space-y-1">
        <p className="font-medium text-sm text-foreground">{capabilityDisplayName[capability]}</p>
        <p className="text-xs text-muted-foreground">
          {hasValue ? 'Workspace override' : 'Using deployment default'}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`provider-${capability}`} className="text-xs uppercase tracking-wide text-muted-foreground">
          Provider
        </Label>
        <Select value={provider} onValueChange={(next) => setProvider(next as LlmProviderName)}>
          <SelectTrigger id={`provider-${capability}`} disabled={busy}>
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
            The saved provider has no API key configured. Add one in Provider API keys above, or clear this row.
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`model-${capability}`} className="text-xs uppercase tracking-wide text-muted-foreground">
          Model
        </Label>
        <ModelPicker
          inputId={`model-${capability}`}
          provider={provider}
          knownModelsByProvider={knownModelsByProvider}
          value={model}
          onChange={setModel}
          disabled={busy}
        />
      </div>
      <div className="flex items-end gap-2">
        <Button type="button" size="sm" onClick={handleSave} disabled={!canSave || busy}>
          Save
        </Button>
        {hasValue ? (
          <Button type="button" size="sm" variant="ghost" onClick={handleClear} disabled={busy}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  )
}

