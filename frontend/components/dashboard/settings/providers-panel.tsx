'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AudioLines, Key, Sparkles } from 'lucide-react'

import { ModelsCard } from '@/components/dashboard/settings/models-card'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import type { SaveStateIndicatorState as SaveState } from '@/components/dashboard/shared/save-state-indicator'
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
import { settingsApi } from '@/lib/api'
import type { IngestionSettings } from '@/lib/api-types'
import {
  emptyEnvProviderAvailability,
  llmProviderNames,
  llmProvidersApi,
  openAiDataResidencies,
  providerDisplayName,
  voiceVendorNames,
  type CredentialProviderName,
  type EnvProviderAvailability,
  type OpenAiDataResidency,
  type ProviderCredentialSummary,
  type WorkspaceLlmModels,
} from '@/lib/api-llm-providers'

const providerVisual: Record<
  CredentialProviderName,
  { monogram: string; tone: string }
> = {
  elevenlabs: {
    monogram: 'EL',
    tone: 'bg-violet-500/10 text-violet-600 ring-violet-500/30 dark:text-violet-300',
  },
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

const residencyDisplayName: Record<OpenAiDataResidency, string> = {
  global: 'Global',
  us: 'US',
  eu: 'EU',
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

  // A workspace key changes which models the workspace can run, so the model pickers reload with it.
  const reloadCredentialsAndModels = useCallback(
    () => Promise.all([reloadCredentials(), reloadModels()]),
    [reloadCredentials, reloadModels],
  )

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
        id="provider-credentials"
        icon={<Key className="h-5 w-5 text-primary" />}
        title="Provider API keys"
        description="Workspace keys are encrypted at rest. They take precedence over deployment-level environment variables when set."
        providers={llmProviderNames}
        notConfiguredHint="Add a key to use this provider in workspace models."
        encryptionConfigured={encryptionConfigured}
        credentials={credentials}
        envProviderAvailability={envProviderAvailability}
        onChange={reloadCredentialsAndModels}
        emitSaveState={emitSaveState}
      />
      <CredentialsCard
        id="voice-vendor-credentials"
        icon={<AudioLines className="h-5 w-5 text-primary" />}
        title="Voice runtime keys"
        description="Radioso sets up your voice agents and starts their sessions with this key, so pages never hold it. Encrypted at rest and never shown again."
        providers={voiceVendorNames}
        notConfiguredHint="Add an ElevenLabs key with the Agents permission (read and write), then connect ElevenLabs on an agent's Voice card."
        encryptionConfigured={encryptionConfigured}
        credentials={credentials}
        envProviderAvailability={{}}
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

/** One list of workspace API keys: the model providers' or the voice runtimes'. */
function CredentialsCard({
  id,
  icon,
  title,
  description,
  providers,
  notConfiguredHint,
  encryptionConfigured,
  credentials,
  envProviderAvailability,
  onChange,
  emitSaveState,
}: {
  id: string
  icon: ReactNode
  title: string
  description: string
  providers: readonly CredentialProviderName[]
  notConfiguredHint: string
  encryptionConfigured: boolean
  credentials: ProviderCredentialSummary[]
  /** Which providers have a deployment key to inherit; a provider it leaves out has none. */
  envProviderAvailability: Partial<Record<CredentialProviderName, boolean>>
  onChange: () => Promise<unknown>
  emitSaveState: (state: SaveState) => void
}) {
  const [editingProvider, setEditingProvider] = useState<CredentialProviderName | null>(null)
  const configuredByProvider = useMemo(
    () => new Map(credentials.map((credential) => [credential.provider, credential])),
    [credentials],
  )

  return (
    <SettingsCard id={id} icon={icon} title={title} description={description}>
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
          {providers.map((provider) => (
            <CredentialRow
              key={`${provider}:${editingProvider === provider ? 'editing' : 'idle'}`}
              provider={provider}
              configured={configuredByProvider.get(provider) ?? null}
              envAvailable={envProviderAvailability[provider] ?? false}
              disabled={!encryptionConfigured}
              editing={editingProvider === provider}
              onStartEditing={() => setEditingProvider(provider)}
              onStopEditing={() => setEditingProvider(null)}
              onChange={onChange}
              emitSaveState={emitSaveState}
              notConfiguredHint={notConfiguredHint}
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
  notConfiguredHint,
}: {
  provider: CredentialProviderName
  configured: ProviderCredentialSummary | null
  envAvailable: boolean
  disabled: boolean
  editing: boolean
  onStartEditing: () => void
  onStopEditing: () => void
  onChange: () => Promise<unknown>
  emitSaveState: (state: SaveState) => void
  notConfiguredHint: string
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const isOpenAi = provider === 'openai'
  // Scoped to this editing session: the row remounts (fresh key, fresh draft) each time
  // editing starts, so this always initializes from the stored residency (or the default,
  // for a first save) and is submitted together with the key on Save.
  const [editingResidency, setEditingResidency] = useState<OpenAiDataResidency>(configured?.residency ?? 'global')
  const [residencyBusy, setResidencyBusy] = useState(false)

  const canSubmit = draft.trim().length > 0

  const handleSave = async () => {
    const apiKey = draft.trim()
    if (apiKey.length === 0) return
    setBusy(true)
    emitSaveState({ state: 'saving' })
    try {
      await llmProvidersApi.setCredential(provider, { apiKey, ...(isOpenAi ? { residency: editingResidency } : {}) })
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

  // Already configured: changes residency alone, immediately, reading and showing the
  // server's own value (`configured.residency`) rather than a local draft — a failed write
  // then shows correctly as unchanged once this reloads.
  const handleResidencyChange = async (next: string) => {
    setResidencyBusy(true)
    emitSaveState({ state: 'saving' })
    try {
      await llmProvidersApi.setCredential(provider, { residency: next as OpenAiDataResidency })
      await onChange()
      emitSaveState({ state: 'saved' })
    } catch (err) {
      emitSaveState({ state: 'error', message: getApiErrorMessage(err, 'Failed to save data residency.') })
    } finally {
      setResidencyBusy(false)
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
      : notConfiguredHint

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
      {isOpenAi && configured && !editing ? (
        <div className="flex shrink-0 items-center gap-2">
          <Label htmlFor={`${provider}-residency`} className="text-xs text-muted-foreground">
            Residency
          </Label>
          <Select value={configured.residency} onValueChange={handleResidencyChange} disabled={disabled || residencyBusy}>
            <SelectTrigger id={`${provider}-residency`} className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {openAiDataResidencies.map((residency) => (
                <SelectItem key={residency} value={residency}>
                  {residencyDisplayName[residency]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {editing ? (
        <div className="flex w-full min-w-0 items-center gap-2 sm:flex-1 sm:justify-end">
          {isOpenAi ? (
            <Select value={editingResidency} onValueChange={(next) => setEditingResidency(next as OpenAiDataResidency)} disabled={busy}>
              <SelectTrigger id={`${provider}-residency`} className="w-24 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {openAiDataResidencies.map((residency) => (
                  <SelectItem key={residency} value={residency}>
                    {residencyDisplayName[residency]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
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
