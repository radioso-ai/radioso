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
  DEFAULT_WEBSITE_EMBED_THEME,
  buildWebsiteEmbedTestHarnessUrl,
  buildWebsiteEmbedSnippet,
  formatWebsiteEmbedOrigins,
  normalizeWebsiteEmbedAvatarUrl,
  normalizeWebsiteEmbedDisplayMode,
  normalizeWebsiteEmbedInitialState,
  parseWebsiteEmbedJsonOverrides,
  parseWebsiteEmbedOrigins,
  sanitizeWebsiteEmbedCopyOverrides,
  sanitizeWebsiteEmbedThemeOverrides,
} from '@/lib/embed-widget'

type SaveState = 'idle' | 'saved' | 'saving' | 'error'
type JsonOverrideRecord = Record<string, unknown>

type WebsiteEmbedSettingsControllerProps = {
  mode: 'workspace' | 'assistant' | 'channels'
  activeWorkspaceName?: string | null
  anonSettings: GeneralSettings | null
  savedAnonSettings: GeneralSettings | null
  setAnonSettings: Dispatch<SetStateAction<GeneralSettings | null>>
  setSavedAnonSettings: Dispatch<SetStateAction<GeneralSettings | null>>
  isAnonSaving: boolean
  setIsAnonSaving: Dispatch<SetStateAction<boolean>>
  updateGeneralSettings?: typeof generalSettingsApi.updateGeneralSettings
  anonDraftVersionRef: MutableRefObject<number>
  saveSequenceRef: MutableRefObject<number>
  setSaveState: (state: SaveState) => void
  setSaveError: (message: string | null) => void
}

const getWebsiteEmbedJsonOverrideRecord = (value: string): JsonOverrideRecord => {
  const parsed = parseWebsiteEmbedJsonOverrides(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  return { ...(parsed as JsonOverrideRecord) }
}

const stringifyWebsiteEmbedJsonOverrideRecord = (value: JsonOverrideRecord) =>
  Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : ''

const updateWebsiteEmbedJsonOverrideValue = (currentValue: string, key: string, nextValue: string) => {
  const nextOverrides = getWebsiteEmbedJsonOverrideRecord(currentValue)
  const trimmedValue = nextValue.trim()

  if (trimmedValue) {
    nextOverrides[key] = trimmedValue
  } else {
    delete nextOverrides[key]
  }

  return stringifyWebsiteEmbedJsonOverrideRecord(nextOverrides)
}

export function WebsiteEmbedSettingsController(props: WebsiteEmbedSettingsControllerProps) {
  if (!editionController.shouldRenderWebsiteEmbedSettings(props.mode)) {
    return null
  }

  return <WebsiteEmbedSettingsPanel {...props} />
}

function WebsiteEmbedSettingsPanel({
  activeWorkspaceName,
  anonSettings,
  savedAnonSettings,
  setAnonSettings,
  setSavedAnonSettings,
  isAnonSaving,
  setIsAnonSaving,
  updateGeneralSettings = generalSettingsApi.updateGeneralSettings,
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
  const [websiteEmbedSnippetDisplayMode, setWebsiteEmbedSnippetDisplayMode] = useState('')
  const [websiteEmbedSnippetInitialState, setWebsiteEmbedSnippetInitialState] = useState('')
  const [websiteEmbedSnippetAvatarUrl, setWebsiteEmbedSnippetAvatarUrl] = useState('')
  const [websiteEmbedSnippetCopyJson, setWebsiteEmbedSnippetCopyJson] = useState('')
  const [websiteEmbedSnippetThemeJson, setWebsiteEmbedSnippetThemeJson] = useState('')
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
          anonSettings.websiteEmbedLauncherIcon !== savedAnonSettings.websiteEmbedLauncherIcon ||
          anonSettings.websiteEmbedLauncherPosition !== savedAnonSettings.websiteEmbedLauncherPosition
        )
      : false

  const websiteEmbedSnippetParsedCopyJson = useMemo(
    () =>
      websiteEmbedSnippetCopyJson.trim().length > 0
        ? parseWebsiteEmbedJsonOverrides(websiteEmbedSnippetCopyJson)
        : null,
    [websiteEmbedSnippetCopyJson],
  )

  const websiteEmbedSnippetParsedThemeJson = useMemo(
    () =>
      websiteEmbedSnippetThemeJson.trim().length > 0
        ? parseWebsiteEmbedJsonOverrides(websiteEmbedSnippetThemeJson)
        : null,
    [websiteEmbedSnippetThemeJson],
  )

  const websiteEmbedSnippetCopyJsonError = useMemo(() => {
    if (!websiteEmbedSnippetCopyJson.trim()) {
      return null
    }

    return websiteEmbedSnippetParsedCopyJson ? null : 'Copy overrides must be valid JSON.'
  }, [websiteEmbedSnippetCopyJson, websiteEmbedSnippetParsedCopyJson])

  const websiteEmbedSnippetThemeJsonError = useMemo(() => {
    if (!websiteEmbedSnippetThemeJson.trim()) {
      return null
    }

    return websiteEmbedSnippetParsedThemeJson ? null : 'Theme overrides must be valid JSON.'
  }, [websiteEmbedSnippetParsedThemeJson, websiteEmbedSnippetThemeJson])

  const websiteEmbedSnippetAvatarUrlError = useMemo(() => {
    if (!websiteEmbedSnippetAvatarUrl.trim()) {
      return null
    }

    return normalizeWebsiteEmbedAvatarUrl(websiteEmbedSnippetAvatarUrl)
      ? null
      : 'Avatar URL must be an http(s) URL or supported relative asset path.'
  }, [websiteEmbedSnippetAvatarUrl])

  const websiteEmbedSnippetCopyOverrides = useMemo(
    () => sanitizeWebsiteEmbedCopyOverrides(websiteEmbedSnippetParsedCopyJson),
    [websiteEmbedSnippetParsedCopyJson],
  )

  const websiteEmbedSnippetResolvedCopyOverrides = useMemo(() => {
    const fallbackEmbeddedChatTitle = anonSettings?.assistantName?.trim() || activeWorkspaceName?.trim()
    if (!fallbackEmbeddedChatTitle || websiteEmbedSnippetCopyOverrides.embeddedChatTitle) {
      return websiteEmbedSnippetCopyOverrides
    }

    return {
      ...websiteEmbedSnippetCopyOverrides,
      embeddedChatTitle: fallbackEmbeddedChatTitle,
    }
  }, [activeWorkspaceName, anonSettings?.assistantName, websiteEmbedSnippetCopyOverrides])

  const websiteEmbedSnippetThemeOverrides = useMemo(
    () => sanitizeWebsiteEmbedThemeOverrides(websiteEmbedSnippetParsedThemeJson),
    [websiteEmbedSnippetParsedThemeJson],
  )

  const websiteEmbedSnippetResolvedThemeOverrides = useMemo(() => {
    const nextOverrides = { ...websiteEmbedSnippetThemeOverrides }

    if (nextOverrides.panelBackground) {
      if (nextOverrides.assistantBubbleBackground === nextOverrides.panelBackground) {
        delete nextOverrides.assistantBubbleBackground
      }
      if (nextOverrides.inputBackground === nextOverrides.panelBackground) {
        delete nextOverrides.inputBackground
      }
      if (nextOverrides.mutedBackground === nextOverrides.panelBackground) {
        delete nextOverrides.mutedBackground
      }
    }

    if (nextOverrides.panelForeground) {
      if (nextOverrides.assistantBubbleForeground === nextOverrides.panelForeground) {
        delete nextOverrides.assistantBubbleForeground
      }
      if (nextOverrides.inputForeground === nextOverrides.panelForeground) {
        delete nextOverrides.inputForeground
      }
      if (nextOverrides.inputPlaceholder === nextOverrides.panelForeground) {
        delete nextOverrides.inputPlaceholder
      }
      if (nextOverrides.mutedForeground === nextOverrides.panelForeground) {
        delete nextOverrides.mutedForeground
      }
    }

    return nextOverrides
  }, [websiteEmbedSnippetThemeOverrides])

  const hasWebsiteEmbedVisibleTextOverrides = Boolean(
    websiteEmbedSnippetCopyOverrides.publicChatSubtitle ||
    websiteEmbedSnippetCopyOverrides.publicChatEmptyTitle ||
    websiteEmbedSnippetCopyOverrides.publicChatEmptyMessage ||
    websiteEmbedSnippetCopyOverrides.startPrompt,
  )

  const hasWebsiteEmbedColorOverrides = Boolean(
    websiteEmbedSnippetThemeOverrides.accent ||
    websiteEmbedSnippetThemeOverrides.accentForeground ||
    websiteEmbedSnippetThemeOverrides.panelBackground ||
    websiteEmbedSnippetThemeOverrides.panelForeground,
  )

  const websiteEmbedSnippet = useMemo(() => {
    if (!anonSettings) {
      return null
    }

    const normalizedDisplayMode = normalizeWebsiteEmbedDisplayMode(websiteEmbedSnippetDisplayMode) ?? undefined
    const normalizedInitialState = normalizeWebsiteEmbedInitialState(websiteEmbedSnippetInitialState) ?? undefined
    const normalizedAvatarUrl =
      websiteEmbedSnippetAvatarUrl.trim().length > 0
        ? normalizeWebsiteEmbedAvatarUrl(websiteEmbedSnippetAvatarUrl)
        : null
    const hasAvatarUrlError =
      websiteEmbedSnippetAvatarUrl.trim().length > 0 && normalizedAvatarUrl === null

    if (websiteEmbedSnippetCopyJsonError || websiteEmbedSnippetThemeJsonError || hasAvatarUrlError) {
      return null
    }

    const hasLocalSnippetOverrides =
      Boolean(normalizedDisplayMode) ||
      Boolean(normalizedInitialState) ||
      Boolean(normalizedAvatarUrl) ||
      Object.keys(websiteEmbedSnippetResolvedCopyOverrides).length > 0 ||
      websiteEmbedSnippetThemeJson.trim().length > 0

    return (
      (!hasLocalSnippetOverrides ? anonSettings.websiteEmbedSnippet : null) ??
      buildWebsiteEmbedSnippet({
        websiteEmbedEnabled: anonSettings.websiteEmbedEnabled ?? false,
        websiteEmbedToken: anonSettings.websiteEmbedToken ?? null,
        websiteEmbedScriptUrl: anonSettings.websiteEmbedScriptUrl ?? null,
        websiteEmbedAllowedOrigins: anonSettings.websiteEmbedAllowedOrigins ?? [],
        websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
        websiteEmbedLauncherIcon: anonSettings.websiteEmbedLauncherIcon ?? 'chat',
        websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
      }, undefined, {
        displayMode: normalizedDisplayMode,
        initialState: normalizedInitialState,
        avatarUrl: normalizedAvatarUrl,
        copy: websiteEmbedSnippetResolvedCopyOverrides,
        theme: websiteEmbedSnippetResolvedThemeOverrides,
      })
    )
  }, [
    anonSettings,
    websiteEmbedSnippetAvatarUrl,
    websiteEmbedSnippetCopyJsonError,
    websiteEmbedSnippetResolvedCopyOverrides,
    websiteEmbedSnippetDisplayMode,
    websiteEmbedSnippetInitialState,
    websiteEmbedSnippetThemeJson,
    websiteEmbedSnippetThemeJsonError,
    websiteEmbedSnippetResolvedThemeOverrides,
  ])

  const hasWebsiteEmbedAdvancedOverrides =
    Boolean(websiteEmbedSnippetInitialState.trim()) ||
    websiteEmbedSnippetCopyJson.trim().length > 0 ||
    websiteEmbedSnippetThemeJson.trim().length > 0

  const websiteEmbedDemoUrl = useMemo(() => {
    if (
      !anonSettings ||
      websiteEmbedSnippetCopyJsonError ||
      websiteEmbedSnippetThemeJsonError ||
      websiteEmbedSnippetAvatarUrlError ||
      typeof window === 'undefined'
    ) {
      return null
    }

    return buildWebsiteEmbedTestHarnessUrl(
      {
        websiteEmbedToken: anonSettings.websiteEmbedToken ?? null,
        websiteEmbedScriptUrl: anonSettings.websiteEmbedScriptUrl ?? null,
        websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
        websiteEmbedLauncherIcon: anonSettings.websiteEmbedLauncherIcon ?? 'chat',
        websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
      },
      window.location.origin,
      {
        displayMode: normalizeWebsiteEmbedDisplayMode(websiteEmbedSnippetDisplayMode) ?? undefined,
        initialState: normalizeWebsiteEmbedInitialState(websiteEmbedSnippetInitialState) ?? undefined,
        avatarUrl: normalizeWebsiteEmbedAvatarUrl(websiteEmbedSnippetAvatarUrl) ?? undefined,
        copy: websiteEmbedSnippetResolvedCopyOverrides,
        theme: websiteEmbedSnippetResolvedThemeOverrides,
      },
    )
  }, [
    anonSettings,
    websiteEmbedSnippetAvatarUrl,
    websiteEmbedSnippetAvatarUrlError,
    websiteEmbedSnippetCopyJsonError,
    websiteEmbedSnippetResolvedCopyOverrides,
    websiteEmbedSnippetDisplayMode,
    websiteEmbedSnippetInitialState,
    websiteEmbedSnippetThemeJsonError,
    websiteEmbedSnippetResolvedThemeOverrides,
  ])

  const websiteEmbedDemoOrigin =
    typeof window !== 'undefined' ? window.location.origin : ''

  const websiteEmbedHasDemoOrigin = useMemo(
    () => (websiteEmbedDemoOrigin ? parseWebsiteEmbedOrigins(websiteEmbedOrigins).includes(websiteEmbedDemoOrigin) : false),
    [websiteEmbedDemoOrigin, websiteEmbedOrigins],
  )

  useEffect(() => {
    if (!anonSettings || !savedAnonSettings || !hasWebsiteEmbedChanges) {
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
          websiteEmbedAllowedOrigins: parseWebsiteEmbedOrigins(websiteEmbedOrigins),
          websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
          websiteEmbedLauncherIcon: anonSettings.websiteEmbedLauncherIcon ?? 'chat',
          websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
        })
        if (saveSequenceRef.current !== saveId) return
        setSavedAnonSettings(updated)
        if (anonDraftVersionRef.current === draftVersionAtRequestStart) {
          setAnonSettings(updated)
          setSaveState('saved')
        }
      } catch (error) {
        if (saveSequenceRef.current !== saveId) return
        console.error('Failed to update website embed settings:', error)
        setSaveState('error')
        setSaveError('Failed to save changes')
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
    websiteEmbedOrigins,
  ])

  const handleWebsiteEmbedSettingChange = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => {
    if (!anonSettings) return
    anonDraftVersionRef.current += 1
    setAnonSettings({ ...anonSettings, [key]: value })
  }

  const handleOpenWebsiteEmbedDemo = async () => {
    if (!anonSettings?.websiteEmbedEnabled || !websiteEmbedDemoUrl || typeof window === 'undefined') {
      return
    }

    setIsPreparingWebsiteEmbedDemo(true)
    setWebsiteEmbedDemoError(null)

    try {
      const parsedOrigins = parseWebsiteEmbedOrigins(websiteEmbedOrigins)
      const nextOrigins = websiteEmbedHasDemoOrigin
        ? parsedOrigins
        : websiteEmbedDemoOrigin
          ? [...parsedOrigins, websiteEmbedDemoOrigin]
          : parsedOrigins

      const hasPersistedChanges =
        !websiteEmbedHasDemoOrigin ||
        anonSettings.websiteEmbedEnabled !== (savedAnonSettings?.websiteEmbedEnabled ?? false) ||
        websiteEmbedOrigins !== formatWebsiteEmbedOrigins(savedAnonSettings?.websiteEmbedAllowedOrigins ?? []) ||
        anonSettings.websiteEmbedLauncherLabel !== savedAnonSettings?.websiteEmbedLauncherLabel ||
        anonSettings.websiteEmbedLauncherIcon !== savedAnonSettings?.websiteEmbedLauncherIcon ||
        anonSettings.websiteEmbedLauncherPosition !== savedAnonSettings?.websiteEmbedLauncherPosition

      if (hasPersistedChanges) {
        const updated = await updateGeneralSettings({
          websiteEmbedEnabled: anonSettings.websiteEmbedEnabled ?? false,
          websiteEmbedAllowedOrigins: nextOrigins,
          websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
          websiteEmbedLauncherIcon: anonSettings.websiteEmbedLauncherIcon ?? 'chat',
          websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
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

  const handleWebsiteEmbedCopyOverrideFieldChange = (key: string, value: string) => {
    setWebsiteEmbedSnippetCopyJson((currentValue) => updateWebsiteEmbedJsonOverrideValue(currentValue, key, value))
  }

  const handleWebsiteEmbedThemeOverrideGroupChange = (keys: readonly string[], value: string) => {
    setWebsiteEmbedSnippetThemeJson((currentValue) => {
      let nextValue = currentValue

      for (const key of keys) {
        nextValue = updateWebsiteEmbedJsonOverrideValue(nextValue, key, value)
      }

      return nextValue
    })
  }

  const handleWebsiteEmbedTokenRotate = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await updateGeneralSettings({
        rotateWebsiteEmbedToken: true,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
    } catch (error) {
      console.error('Failed to rotate website embed token:', error)
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

          <div className="space-y-2 md:max-w-xs">
            <Label htmlFor="websiteEmbedLauncherIcon" className="text-foreground">Launcher icon</Label>
            <select
              id="websiteEmbedLauncherIcon"
              value={anonSettings.websiteEmbedLauncherIcon ?? 'chat'}
              onChange={(event) =>
                handleWebsiteEmbedSettingChange('websiteEmbedLauncherIcon', event.target.value as GeneralSettings['websiteEmbedLauncherIcon'])
              }
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="chat">Chat bubble</option>
              <option value="sparkles">Sparkles</option>
              <option value="message">Message</option>
            </select>
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
                Most installs should keep the hosted widget defaults and only set an avatar when needed. Text,
                colors, and launch behavior stay tucked away under optional customize sections.
              </p>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="websiteEmbedSnippetDisplayMode" className="text-foreground">Display mode</Label>
                  <select
                    id="websiteEmbedSnippetDisplayMode"
                    value={websiteEmbedSnippetDisplayMode}
                    onChange={(event) => setWebsiteEmbedSnippetDisplayMode(event.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                  >
                    <option value="">Floating launcher bubble</option>
                    <option value="panel">Retractable side panel</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Use the side panel mode to dock the chat to the page edge with a retractable full-height shell.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="websiteEmbedSnippetAvatarUrl" className="text-foreground">Avatar image or GIF URL</Label>
                <Input
                  id="websiteEmbedSnippetAvatarUrl"
                  value={websiteEmbedSnippetAvatarUrl}
                  onChange={(event) => setWebsiteEmbedSnippetAvatarUrl(event.target.value)}
                  placeholder="https://cdn.example.com/support-avatar.gif"
                />
                {websiteEmbedSnippetAvatarUrlError ? (
                  <p className="text-xs text-destructive">{websiteEmbedSnippetAvatarUrlError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    When set, this replaces the built-in launcher icon and the assistant avatar inside the hosted chat.
                  </p>
                )}
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <details className="rounded-md border border-border bg-background/80 p-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">Customize visible text</p>
                      <p className="text-xs text-muted-foreground">
                        Override the subtitle, empty state, and composer placeholder without touching JSON.
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {hasWebsiteEmbedVisibleTextOverrides ? 'Custom text active' : 'Optional'}
                    </span>
                  </summary>

                  <div className="mt-4 space-y-4">
                    <p className="text-xs text-muted-foreground">
                      Leave any field blank to inherit the default English copy.
                    </p>

                    <div className="space-y-2">
                      <Label htmlFor="websiteEmbedSnippetSubtitle" className="text-foreground">Header subtitle</Label>
                      <Input
                        id="websiteEmbedSnippetSubtitle"
                        value={websiteEmbedSnippetCopyOverrides.publicChatSubtitle ?? ''}
                        onChange={(event) =>
                          handleWebsiteEmbedCopyOverrideFieldChange('publicChatSubtitle', event.target.value)
                        }
                        placeholder="Ask questions and get AI-powered answers"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="websiteEmbedSnippetEmptyTitle" className="text-foreground">Empty-state title</Label>
                      <Input
                        id="websiteEmbedSnippetEmptyTitle"
                        value={websiteEmbedSnippetCopyOverrides.publicChatEmptyTitle ?? ''}
                        onChange={(event) =>
                          handleWebsiteEmbedCopyOverrideFieldChange('publicChatEmptyTitle', event.target.value)
                        }
                        placeholder="Start a conversation"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="websiteEmbedSnippetEmptyMessage" className="text-foreground">Empty-state message</Label>
                      <Textarea
                        id="websiteEmbedSnippetEmptyMessage"
                        value={websiteEmbedSnippetCopyOverrides.publicChatEmptyMessage ?? ''}
                        onChange={(event) =>
                          handleWebsiteEmbedCopyOverrideFieldChange('publicChatEmptyMessage', event.target.value)
                        }
                        placeholder="Ask a question and get an AI-powered answer."
                        className="min-h-[80px]"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="websiteEmbedSnippetStartPrompt" className="text-foreground">Composer placeholder</Label>
                      <Input
                        id="websiteEmbedSnippetStartPrompt"
                        value={websiteEmbedSnippetCopyOverrides.startPrompt ?? ''}
                        onChange={(event) =>
                          handleWebsiteEmbedCopyOverrideFieldChange('startPrompt', event.target.value)
                        }
                        placeholder="Ask a question..."
                      />
                    </div>
                  </div>
                </details>

                <details className="rounded-md border border-border bg-background/80 p-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">Customize colors</p>
                      <p className="text-xs text-muted-foreground">
                        Set the main brand and surface colors without mapping individual theme tokens.
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {hasWebsiteEmbedColorOverrides ? 'Custom colors active' : 'Optional'}
                    </span>
                  </summary>

                  <div className="mt-4 space-y-4">
                    <p className="text-xs text-muted-foreground">
                      These high-level fields update the main launcher, panel, and message colors together. Use
                      hex colors here. Expert JSON is still available for borders, shadows, or split bubble
                      colors.
                    </p>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="websiteEmbedSnippetAccentColor" className="text-foreground">Brand color</Label>
                        <Input
                          id="websiteEmbedSnippetAccentColor"
                          value={websiteEmbedSnippetThemeOverrides.accent ?? ''}
                          onChange={(event) =>
                            handleWebsiteEmbedThemeOverrideGroupChange(
                              ['accent', 'launcherBackground', 'userBubbleBackground'],
                              event.target.value,
                            )
                          }
                          placeholder={DEFAULT_WEBSITE_EMBED_THEME.accent}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="websiteEmbedSnippetAccentForeground" className="text-foreground">Brand text color</Label>
                        <Input
                          id="websiteEmbedSnippetAccentForeground"
                          value={websiteEmbedSnippetThemeOverrides.accentForeground ?? ''}
                          onChange={(event) =>
                            handleWebsiteEmbedThemeOverrideGroupChange(
                              ['accentForeground', 'launcherForeground', 'userBubbleForeground'],
                              event.target.value,
                            )
                          }
                          placeholder={DEFAULT_WEBSITE_EMBED_THEME.accentForeground}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="websiteEmbedSnippetSurfaceBackground" className="text-foreground">Surface background</Label>
                        <Input
                          id="websiteEmbedSnippetSurfaceBackground"
                          value={websiteEmbedSnippetThemeOverrides.panelBackground ?? ''}
                          onChange={(event) =>
                            handleWebsiteEmbedThemeOverrideGroupChange(
                              ['panelBackground', 'assistantBubbleBackground', 'inputBackground', 'mutedBackground'],
                              event.target.value,
                            )
                          }
                          placeholder={DEFAULT_WEBSITE_EMBED_THEME.panelBackground}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="websiteEmbedSnippetSurfaceForeground" className="text-foreground">Surface text color</Label>
                        <Input
                          id="websiteEmbedSnippetSurfaceForeground"
                          value={websiteEmbedSnippetThemeOverrides.panelForeground ?? ''}
                          onChange={(event) =>
                            handleWebsiteEmbedThemeOverrideGroupChange(
                              [
                                'panelForeground',
                                'assistantBubbleForeground',
                                'inputForeground',
                                'inputPlaceholder',
                                'mutedForeground',
                              ],
                              event.target.value,
                            )
                          }
                          placeholder={DEFAULT_WEBSITE_EMBED_THEME.panelForeground}
                        />
                      </div>
                    </div>
                  </div>
                </details>
              </div>

              <details className="rounded-md border border-border bg-background/80 p-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Expert JSON overrides</p>
                    <p className="text-xs text-muted-foreground">
                      Only use this when you need launch behavior or token-level control beyond the named fields above.
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {hasWebsiteEmbedAdvancedOverrides ? 'Custom overrides active' : 'Optional'}
                  </span>
                </summary>

                <div className="mt-4 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="websiteEmbedSnippetInitialState" className="text-foreground">Open behavior</Label>
                    <select
                      id="websiteEmbedSnippetInitialState"
                      value={websiteEmbedSnippetInitialState}
                      onChange={(event) => setWebsiteEmbedSnippetInitialState(event.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                    >
                      <option value="">Use workspace default</option>
                      <option value="collapsed">Start collapsed</option>
                      <option value="open">Start open</option>
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Leave this unset unless the customer explicitly wants the panel to open immediately.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="websiteEmbedSnippetCopyJson" className="text-foreground">Copy overrides JSON</Label>
                    <Textarea
                      id="websiteEmbedSnippetCopyJson"
                      value={websiteEmbedSnippetCopyJson}
                      onChange={(event) => setWebsiteEmbedSnippetCopyJson(event.target.value)}
                      placeholder={`{"publicChatNewChatLabel":"Clear chat","publicChatDisclaimerTemplate":"{name} uses AI and can make mistakes."}`}
                      className="min-h-[96px] font-mono text-xs"
                    />
                    {websiteEmbedSnippetCopyJsonError ? (
                      <p className="text-xs text-destructive">{websiteEmbedSnippetCopyJsonError}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Use this for less common text keys such as unavailable states, rate-limit copy, or the
                        new-chat button label.
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="websiteEmbedSnippetThemeJson" className="text-foreground">Theme overrides JSON</Label>
                    <Textarea
                      id="websiteEmbedSnippetThemeJson"
                      value={websiteEmbedSnippetThemeJson}
                      onChange={(event) => setWebsiteEmbedSnippetThemeJson(event.target.value)}
                      placeholder={`{"panelBorder":"#cbd5e1","launcherShadow":"0 18px 40px rgba(15,23,42,0.24)"}`}
                      className="min-h-[96px] font-mono text-xs"
                    />
                    {websiteEmbedSnippetThemeJsonError ? (
                      <p className="text-xs text-destructive">{websiteEmbedSnippetThemeJsonError}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Use this when you need borders, shadows, separate bubble colors, or other token-level
                        theme control.
                      </p>
                    )}
                  </div>
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
              <p className="text-sm text-muted-foreground">
                Optional script attributes can set the language, start the widget open, swap in a custom avatar
                image or GIF, and apply the text or color customizations configured above.
              </p>
              <p className="text-xs text-muted-foreground">
                Quick tryout: this action saves the current website embed settings, adds the current app origin to the approved origins when needed, and opens a same-origin demo page prefilled with the current widget configuration.
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
                  Rotate embed token
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
