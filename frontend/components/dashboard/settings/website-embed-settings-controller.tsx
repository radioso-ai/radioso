'use client'

import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useMemo, useState } from 'react'
import { Code2, ExternalLink, Globe, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import { generalSettingsApi, type GeneralSettings } from '@/lib/api'
import { editionController } from '@/lib/edition-controller'
import {
  buildWebsiteEmbedTestHarnessUrl,
  buildWebsiteEmbedSnippet,
  formatWebsiteEmbedOrigins,
  parseWebsiteEmbedOrigins,
} from '@/lib/embed-widget'

type SaveState = 'idle' | 'saved' | 'saving' | 'error'

type WebsiteEmbedSettingsControllerProps = {
  mode: 'workspace' | 'assistant' | 'channels'
  anonSettings: GeneralSettings | null
  savedAnonSettings: GeneralSettings | null
  setAnonSettings: Dispatch<SetStateAction<GeneralSettings | null>>
  setSavedAnonSettings: Dispatch<SetStateAction<GeneralSettings | null>>
  isAnonSaving: boolean
  setIsAnonSaving: Dispatch<SetStateAction<boolean>>
  updateGeneralSettings?: typeof generalSettingsApi.updateGeneralSettings
  rotateWebsiteEmbedToken?: () => Promise<GeneralSettings>
  anonDraftVersionRef: MutableRefObject<number>
  saveSequenceRef: MutableRefObject<number>
  setSaveState: (state: SaveState) => void
  setSaveError: (message: string | null) => void
}

const COPY_FIELDS = [
  ['publicChatSubtitle', 'Header subtitle', 'Ask questions and get AI-powered answers'],
  ['publicChatEmptyTitle', 'Empty-state title', 'Start a conversation'],
  ['publicChatEmptyMessage', 'Empty-state message', 'Ask a question and get an AI-powered answer.'],
  ['startPrompt', 'Composer placeholder', 'Ask a question...'],
  ['publicChatNewChatLabel', 'New chat button', 'Clear chat'],
  ['publicChatDisclaimerTemplate', 'Disclaimer', '{name} uses AI and can make mistakes.'],
] as const

const EXPERT_FIELDS = [
  ['displayMode', 'Display mode', 'bubble or panel'],
  ['initialState', 'Initial state', 'collapsed or open'],
  ['pageContext', 'Page context', 'metadata or content'],
  ['launcherBackground', 'Launcher background', 'CSS color or gradient'],
  ['launcherForeground', 'Launcher text', 'CSS color'],
  ['launcherBorder', 'Launcher border', 'CSS color'],
  ['launcherShadow', 'Launcher shadow', 'CSS shadow'],
  ['panelBackground', 'Panel background', 'CSS color'],
  ['panelForeground', 'Panel text', 'CSS color'],
  ['panelBorder', 'Panel border', 'CSS color'],
  ['panelShadow', 'Panel shadow', 'CSS shadow'],
  ['mutedBackground', 'Muted background', 'CSS color'],
  ['mutedForeground', 'Muted text', 'CSS color'],
  ['inputBackground', 'Input background', 'CSS color'],
  ['inputForeground', 'Input text', 'CSS color'],
  ['inputBorder', 'Input border', 'CSS color'],
  ['inputPlaceholder', 'Input placeholder', 'CSS color'],
  ['assistantBubbleBackground', 'Assistant bubble background', 'CSS color'],
  ['assistantBubbleForeground', 'Assistant bubble text', 'CSS color'],
  ['userBubbleBackground', 'User bubble background', 'CSS color'],
  ['userBubbleForeground', 'User bubble text', 'CSS color'],
] as const

export function WebsiteEmbedSettingsController(props: WebsiteEmbedSettingsControllerProps) {
  if (!editionController.shouldRenderWebsiteEmbedSettings(props.mode)) {
    return null
  }

  return <WebsiteEmbedSettingsPanel {...props} />
}

function WebsiteEmbedSettingsPanel({
  anonSettings,
  savedAnonSettings,
  setAnonSettings,
  setSavedAnonSettings,
  isAnonSaving,
  setIsAnonSaving,
  updateGeneralSettings = generalSettingsApi.updateGeneralSettings,
  rotateWebsiteEmbedToken = () => generalSettingsApi.rotateWebsiteEmbedToken({ auth: 'session' }),
  anonDraftVersionRef,
  saveSequenceRef,
  setSaveState,
  setSaveError,
}: WebsiteEmbedSettingsControllerProps) {
  const savedWebsiteEmbedOrigins = formatWebsiteEmbedOrigins(anonSettings?.websiteEmbedAllowedOrigins ?? [])
  const [websiteEmbedOriginsDraft, setWebsiteEmbedOriginsDraft] = useState(() => ({
    savedOrigins: savedWebsiteEmbedOrigins,
    value: savedWebsiteEmbedOrigins,
  }))
  const websiteEmbedOrigins =
    websiteEmbedOriginsDraft.savedOrigins === savedWebsiteEmbedOrigins
      ? websiteEmbedOriginsDraft.value
      : savedWebsiteEmbedOrigins
  const websiteEmbedAllowedOrigins = useMemo(() => parseWebsiteEmbedOrigins(websiteEmbedOrigins), [websiteEmbedOrigins])
  const [websiteEmbedCopyLocale, setWebsiteEmbedCopyLocale] = useState('en')
  const [isPreparingWebsiteEmbedDemo, setIsPreparingWebsiteEmbedDemo] = useState(false)
  const [websiteEmbedDemoError, setWebsiteEmbedDemoError] = useState<string | null>(null)

  const setWebsiteEmbedOrigins = (value: string) => {
    setWebsiteEmbedOriginsDraft({ savedOrigins: savedWebsiteEmbedOrigins, value })
  }

  const hasWebsiteEmbedChanges =
    anonSettings && savedAnonSettings
      ? (
          anonSettings.websiteEmbedEnabled !== savedAnonSettings.websiteEmbedEnabled ||
          websiteEmbedOrigins !== savedWebsiteEmbedOrigins ||
          anonSettings.websiteEmbedLauncherLabel !== savedAnonSettings.websiteEmbedLauncherLabel ||
          anonSettings.websiteEmbedLauncherPosition !== savedAnonSettings.websiteEmbedLauncherPosition ||
          JSON.stringify(anonSettings.websiteEmbedCopy ?? {}) !== JSON.stringify(savedAnonSettings.websiteEmbedCopy ?? {}) ||
          JSON.stringify(anonSettings.websiteEmbedExpertOverrides ?? {}) !==
            JSON.stringify(savedAnonSettings.websiteEmbedExpertOverrides ?? {})
        )
      : false

  const websiteEmbedSnippet = useMemo(() => {
    if (!anonSettings) {
      return null
    }

    return anonSettings.websiteEmbedSnippet ?? buildWebsiteEmbedSnippet({
      websiteEmbedEnabled: anonSettings.websiteEmbedEnabled ?? false,
      websiteEmbedToken: anonSettings.websiteEmbedToken ?? null,
      websiteEmbedScriptUrl: anonSettings.websiteEmbedScriptUrl ?? null,
    })
  }, [anonSettings])

  const activeCopyPack = anonSettings?.websiteEmbedCopy?.[websiteEmbedCopyLocale] ?? {}
  const hasWebsiteEmbedAdvancedOverrides = Object.keys(anonSettings?.websiteEmbedExpertOverrides ?? {}).length > 0

  const websiteEmbedDemoUrl = useMemo(() => {
    if (
      !anonSettings ||
      typeof window === 'undefined'
    ) {
      return null
    }

    return buildWebsiteEmbedTestHarnessUrl(
      {
        websiteEmbedToken: anonSettings.websiteEmbedToken ?? null,
        websiteEmbedScriptUrl: anonSettings.websiteEmbedScriptUrl ?? null,
        websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
        websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
      },
      window.location.origin,
    )
  }, [
    anonSettings,
  ])

  const websiteEmbedDemoOrigin =
    typeof window !== 'undefined' ? window.location.origin : ''

  const websiteEmbedHasDemoOrigin = useMemo(
    () => (websiteEmbedDemoOrigin ? websiteEmbedAllowedOrigins.includes(websiteEmbedDemoOrigin) : false),
    [websiteEmbedAllowedOrigins, websiteEmbedDemoOrigin],
  )

  useEffect(() => {
    if (!anonSettings || !savedAnonSettings || !hasWebsiteEmbedChanges) {
      return
    }

    if ((anonSettings.websiteEmbedEnabled ?? false) && websiteEmbedAllowedOrigins.length === 0) {
      setSaveState('error')
      setSaveError('Add at least one approved origin to enable the website widget.')
      return
    }

    const timeout = window.setTimeout(async () => {
      const draftVersionAtRequestStart = anonDraftVersionRef.current
      const saveId = saveSequenceRef.current + 1
      saveSequenceRef.current = saveId
      setIsAnonSaving(true)
      setSaveState('saving')
      setSaveError(null)
      try {
        const updated = await updateGeneralSettings({
          websiteEmbedEnabled: anonSettings.websiteEmbedEnabled ?? false,
          websiteEmbedAllowedOrigins,
          websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
          websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
          websiteEmbedCopy: anonSettings.websiteEmbedCopy ?? {},
          websiteEmbedExpertOverrides: anonSettings.websiteEmbedExpertOverrides ?? {},
        })
        if (saveSequenceRef.current !== saveId) return
        setSavedAnonSettings(updated)
        if (anonDraftVersionRef.current === draftVersionAtRequestStart) {
          setAnonSettings(updated)
          setSaveState('saved')
        }
      } catch (error) {
        if (saveSequenceRef.current !== saveId) return
        const message = getApiErrorMessage(error, 'Failed to save website embed settings')
        console.error('Failed to update website embed settings:', message, error)
        setSaveState('error')
        setSaveError(message)
      } finally {
        if (saveSequenceRef.current === saveId) {
          setIsAnonSaving(false)
        }
      }
    }, 700)

    return () => window.clearTimeout(timeout)
  }, [
    anonDraftVersionRef,
    anonSettings,
    hasWebsiteEmbedChanges,
    saveSequenceRef,
    savedAnonSettings,
    setAnonSettings,
    setIsAnonSaving,
    setSaveError,
    setSavedAnonSettings,
    setSaveState,
    updateGeneralSettings,
    websiteEmbedAllowedOrigins,
    websiteEmbedOrigins,
  ])

  const handleWebsiteEmbedSettingChange = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => {
    if (!anonSettings) return
    anonDraftVersionRef.current += 1
    if (key === 'websiteEmbedEnabled' && value === true && websiteEmbedAllowedOrigins.length === 0 && websiteEmbedDemoOrigin) {
      setWebsiteEmbedOrigins(websiteEmbedDemoOrigin)
    }
    setAnonSettings({ ...anonSettings, [key]: value })
  }

  const handleOpenWebsiteEmbedDemo = async () => {
    if (!anonSettings?.websiteEmbedEnabled || !websiteEmbedDemoUrl || typeof window === 'undefined') {
      return
    }

    setIsPreparingWebsiteEmbedDemo(true)
    setWebsiteEmbedDemoError(null)

    try {
      const nextOrigins = websiteEmbedHasDemoOrigin
        ? websiteEmbedAllowedOrigins
        : websiteEmbedDemoOrigin
          ? [...websiteEmbedAllowedOrigins, websiteEmbedDemoOrigin]
          : websiteEmbedAllowedOrigins

      const hasPersistedChanges =
        !websiteEmbedHasDemoOrigin ||
        anonSettings.websiteEmbedEnabled !== (savedAnonSettings?.websiteEmbedEnabled ?? false) ||
        websiteEmbedOrigins !== formatWebsiteEmbedOrigins(savedAnonSettings?.websiteEmbedAllowedOrigins ?? []) ||
        anonSettings.websiteEmbedLauncherLabel !== savedAnonSettings?.websiteEmbedLauncherLabel ||
        anonSettings.websiteEmbedLauncherPosition !== savedAnonSettings?.websiteEmbedLauncherPosition ||
        JSON.stringify(anonSettings.websiteEmbedCopy ?? {}) !== JSON.stringify(savedAnonSettings?.websiteEmbedCopy ?? {}) ||
        JSON.stringify(anonSettings.websiteEmbedExpertOverrides ?? {}) !==
          JSON.stringify(savedAnonSettings?.websiteEmbedExpertOverrides ?? {})

      if (hasPersistedChanges) {
        const updated = await updateGeneralSettings({
          websiteEmbedEnabled: anonSettings.websiteEmbedEnabled ?? false,
          websiteEmbedAllowedOrigins: nextOrigins,
          websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
          websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
          websiteEmbedCopy: anonSettings.websiteEmbedCopy ?? {},
          websiteEmbedExpertOverrides: anonSettings.websiteEmbedExpertOverrides ?? {},
        })
        setAnonSettings(updated)
        setSavedAnonSettings(updated)
      }

      window.open(websiteEmbedDemoUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      console.error('Failed to prepare website embed demo page:', error)
      setWebsiteEmbedDemoError(getApiErrorMessage(error, 'Failed to prepare the demo page.'))
    } finally {
      setIsPreparingWebsiteEmbedDemo(false)
    }
  }

  const handleWebsiteEmbedCopyFieldChange = (key: string, value: string) => {
    if (!anonSettings) return
    const locale = websiteEmbedCopyLocale.trim() || 'en'
    const nextCopy = { ...(anonSettings.websiteEmbedCopy ?? {}) }
    const nextPack = { ...(nextCopy[locale] ?? {}) }
    if (value.trim()) {
      nextPack[key] = value
    } else {
      delete nextPack[key]
    }
    if (Object.keys(nextPack).length > 0) {
      nextCopy[locale] = nextPack
    } else {
      delete nextCopy[locale]
    }
    anonDraftVersionRef.current += 1
    setAnonSettings({ ...anonSettings, websiteEmbedCopy: nextCopy })
  }

  const handleWebsiteEmbedExpertOverrideChange = (key: string, value: string) => {
    if (!anonSettings) return
    const nextOverrides = { ...(anonSettings.websiteEmbedExpertOverrides ?? {}) }
    if (value.trim()) {
      nextOverrides[key] = value
    } else {
      delete nextOverrides[key]
    }
    anonDraftVersionRef.current += 1
    setAnonSettings({ ...anonSettings, websiteEmbedExpertOverrides: nextOverrides })
  }

  const handleWebsiteEmbedTokenRotate = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await rotateWebsiteEmbedToken()
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
    } catch (error) {
      const message = getApiErrorMessage(error, 'Failed to reset website embed token')
      console.error('Failed to rotate website embed token:', message, error)
      setSaveState('error')
      setSaveError(message)
    } finally {
      setIsAnonSaving(false)
    }
  }

  return (
    <section id="website-embed" className="space-y-6 scroll-mt-24">
      {anonSettings ? (
        <section className="scroll-mt-24 rounded-2xl border border-border bg-card/95 p-5 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
                <Globe className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <h3 className="font-medium text-foreground">Hosted website widget</h3>
                <p className="text-sm text-muted-foreground">
                  Radioso-hosted launcher script and iframe chat for approved sites.
                </p>
              </div>
            </div>
            <Switch
              id="websiteEmbedToggle"
              checked={anonSettings.websiteEmbedEnabled ?? false}
              onCheckedChange={(checked) => handleWebsiteEmbedSettingChange('websiteEmbedEnabled', checked)}
              disabled={isAnonSaving}
              className="sm:mt-3"
            />
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="websiteEmbedLauncherLabel" className="text-foreground">Launcher label</Label>
              <Input
                id="websiteEmbedLauncherLabel"
                value={anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us'}
                maxLength={80}
                onChange={(event) => handleWebsiteEmbedSettingChange('websiteEmbedLauncherLabel', event.target.value)}
                placeholder="Chat with us"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="websiteEmbedLauncherPosition" className="text-foreground">Launcher position</Label>
              <select
                id="websiteEmbedLauncherPosition"
                value={anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right'}
                onChange={(event) =>
                  handleWebsiteEmbedSettingChange('websiteEmbedLauncherPosition', event.target.value as GeneralSettings['websiteEmbedLauncherPosition'])
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              >
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="websiteEmbedAllowedOrigins" className="text-foreground">Approved origins</Label>
            <Textarea
              id="websiteEmbedAllowedOrigins"
              value={websiteEmbedOrigins}
              onChange={(event) => {
                anonDraftVersionRef.current += 1
                setWebsiteEmbedOrigins(event.target.value)
              }}
              placeholder={`https://example.com\nhttps://docs.example.com`}
              className="min-h-[132px]"
            />
            <p className="text-sm text-muted-foreground">
              Approved site origins for the embedded assistant, one per line.
            </p>
          </div>

          {anonSettings.websiteEmbedEnabled ? (
            <div className="rounded bg-muted/50 p-3 space-y-3">
              <div className="flex items-center gap-2 text-foreground">
                <Code2 className="h-4 w-4" />
                <Label className="text-foreground">Install snippet</Label>
              </div>
              <p className="text-sm text-muted-foreground">
                The snippet only contains the loader URL and embed token. Branding, text, theme, and expert behavior are stored in Radioso settings.
              </p>

              <details className="rounded-md border border-border bg-background/80 p-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Locale text packs</p>
                    <p className="text-xs text-muted-foreground">
                      Add translated copy per locale. Browser language picks the closest pack and falls back to defaults.
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {Object.keys(anonSettings.websiteEmbedCopy ?? {}).length > 0 ? 'Custom text active' : 'Optional'}
                  </span>
                </summary>

                <div className="mt-4 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="websiteEmbedCopyLocale" className="text-foreground">Locale</Label>
                    <Input
                      id="websiteEmbedCopyLocale"
                      value={websiteEmbedCopyLocale}
                      onChange={(event) => setWebsiteEmbedCopyLocale(event.target.value)}
                      placeholder="en, it, fr-CA"
                    />
                  </div>

                  {COPY_FIELDS.map(([key, label, placeholder]) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={`websiteEmbedCopy-${key}`} className="text-foreground">{label}</Label>
                      <Input
                        id={`websiteEmbedCopy-${key}`}
                        value={activeCopyPack[key] ?? ''}
                        onChange={(event) => handleWebsiteEmbedCopyFieldChange(key, event.target.value)}
                        placeholder={placeholder}
                      />
                    </div>
                  ))}
                </div>
              </details>

              <details className="rounded-md border border-border bg-background/80 p-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Expert overrides</p>
                    <p className="text-xs text-muted-foreground">
                      Override individual widget properties from the schema. Blank values inherit the derived theme and default behavior.
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {hasWebsiteEmbedAdvancedOverrides ? 'Custom overrides active' : 'Optional'}
                  </span>
                </summary>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {EXPERT_FIELDS.map(([key, label, placeholder]) => (
                    <div key={key} className="space-y-2">
                      <Label htmlFor={`websiteEmbedExpert-${key}`} className="text-foreground">{label}</Label>
                      <Input
                        id={`websiteEmbedExpert-${key}`}
                        value={anonSettings.websiteEmbedExpertOverrides?.[key] ?? ''}
                        onChange={(event) => handleWebsiteEmbedExpertOverrideChange(key, event.target.value)}
                        placeholder={placeholder}
                      />
                    </div>
                  ))}
                </div>
              </details>

              {websiteEmbedSnippet ? (
                <CopyValueField
                  value={websiteEmbedSnippet}
                  ariaLabel="Copy install snippet"
                  className="w-full"
                  wrap
                />
              ) : (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  Fix the snippet override errors above to generate a copyable script tag.
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                Paste this script tag into the target website. The loader opens a Radioso-hosted iframe on approved domains only.
              </p>
              <p className="text-xs text-muted-foreground">
                Quick tryout: this action saves the current website embed settings, adds the current app origin to the approved origins when needed, and opens a same-origin demo page.
              </p>
              {websiteEmbedDemoError ? (
                <p className="text-xs text-destructive">{websiteEmbedDemoError}</p>
              ) : null}
              {anonSettings.websiteEmbedScriptUrl ? (
                <p className="text-xs text-muted-foreground">
                  Loader URL: <span className="font-mono">{anonSettings.websiteEmbedScriptUrl}</span>
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={handleOpenWebsiteEmbedDemo}
                  disabled={
                    isAnonSaving ||
                    isPreparingWebsiteEmbedDemo ||
                    !anonSettings.websiteEmbedEnabled ||
                    !websiteEmbedDemoUrl
                  }
                >
                  {isPreparingWebsiteEmbedDemo ? (
                    <Spinner className="mr-2 h-4 w-4" />
                  ) : (
                    <ExternalLink className="mr-2 h-4 w-4" />
                  )}
                  Open demo page
                </Button>
                <Button variant="outline" onClick={handleWebsiteEmbedTokenRotate} disabled={isAnonSaving}>
                  {isAnonSaving ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Reset embed token
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">Failed to load website settings.</p>
      )}
    </section>
  )
}
