'use client'

import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Code2, ExternalLink, Globe, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/markdown/code-block'
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
  ['publicChatContactHumanLabel', 'Contact-human button', 'Talk to a human'],
  ['publicChatContactHumanMessage', 'Contact-human message', 'I want to talk to a human.'],
  ['publicChatDisclaimerTemplate', 'Disclaimer', '{name} uses AI and can make mistakes.'],
] as const

const ATTENTION_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'None' },
  { value: 'breathe', label: 'Breathe' },
  { value: 'pulse', label: 'Pulse' },
  { value: 'nudge', label: 'Nudge' },
  { value: 'bounce-in', label: 'Bounce in' },
]

const DISPLAY_MODES: { value: 'bubble' | 'panel'; label: string; description: string }[] = [
  {
    value: 'bubble',
    label: 'Bubble',
    description: 'Shows a round chat button in the corner of every page. Visitors tap it to open a small chat window.',
  },
  {
    value: 'panel',
    label: 'Side panel',
    description: 'Shows a slim tab on the side of every page. Visitors tap it and a tall chat panel slides out.',
  },
]

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
  const displayMode =
    (anonSettings?.websiteEmbedExpertOverrides?.displayMode ?? 'bubble') === 'panel' ? 'panel' : 'bubble'

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
      const message = getApiErrorMessage(error, 'Could not generate a new install code. Please try again.')
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
                <h3 className="font-medium text-foreground">Website chat widget</h3>
                <p className="text-sm text-muted-foreground">
                  Add a chat button to your website so visitors can ask the assistant questions.
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

          <div className="mt-5 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="websiteEmbedDisplayMode" className="text-foreground">Display mode</Label>
              <select
                id="websiteEmbedDisplayMode"
                value={(anonSettings.websiteEmbedExpertOverrides?.displayMode ?? 'bubble') as 'bubble' | 'panel'}
                onChange={(event) =>
                  handleWebsiteEmbedExpertOverrideChange('displayMode', event.target.value === 'bubble' ? '' : event.target.value)
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {DISPLAY_MODES.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {DISPLAY_MODES.find(
                  (mode) => mode.value === ((anonSettings.websiteEmbedExpertOverrides?.displayMode ?? 'bubble') as 'bubble' | 'panel'),
                )?.description}
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="websiteEmbedLauncherLabel" className="text-foreground">
                  {displayMode === 'panel' ? 'Tooltip text' : 'Button text'}
                </Label>
                <Input
                  id="websiteEmbedLauncherLabel"
                  value={anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us'}
                  maxLength={80}
                  onChange={(event) => handleWebsiteEmbedSettingChange('websiteEmbedLauncherLabel', event.target.value)}
                  placeholder="Chat with us"
                />
                <p className="text-xs text-muted-foreground">
                  {displayMode === 'panel'
                    ? 'Shown when visitors hover the side tab. Leave blank for no tooltip text.'
                    : 'The words visitors see on the chat button. Leave blank for an icon-only button.'}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="websiteEmbedLauncherPosition" className="text-foreground">
                  {displayMode === 'panel' ? 'Which side' : 'Where to show it'}
                </Label>
                <select
                  id="websiteEmbedLauncherPosition"
                  value={anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right'}
                  onChange={(event) =>
                    handleWebsiteEmbedSettingChange('websiteEmbedLauncherPosition', event.target.value as GeneralSettings['websiteEmbedLauncherPosition'])
                  }
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="bottom-right">{displayMode === 'panel' ? 'Right edge' : 'Bottom-right corner'}</option>
                  <option value="bottom-left">{displayMode === 'panel' ? 'Left edge' : 'Bottom-left corner'}</option>
                </select>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="websiteEmbedInitialState" className="text-foreground">When a page loads</Label>
                <select
                  id="websiteEmbedInitialState"
                  value={(anonSettings.websiteEmbedExpertOverrides?.initialState ?? 'collapsed') as 'collapsed' | 'open'}
                  onChange={(event) =>
                    handleWebsiteEmbedExpertOverrideChange('initialState', event.target.value === 'collapsed' ? '' : event.target.value)
                  }
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="collapsed">Stay closed until visitor opens it</option>
                  <option value="open">Open chat automatically</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="websiteEmbedPageContext" className="text-foreground">What the assistant knows about the page</Label>
                <select
                  id="websiteEmbedPageContext"
                  value={(anonSettings.websiteEmbedExpertOverrides?.pageContext ?? 'metadata') as 'metadata' | 'content'}
                  onChange={(event) =>
                    handleWebsiteEmbedExpertOverrideChange('pageContext', event.target.value === 'metadata' ? '' : event.target.value)
                  }
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                >
                  <option value="metadata">Just the page title and address</option>
                  <option value="content">Everything visible on the page</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Helps the assistant give answers about what the visitor is looking at.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-5 space-y-2">
            <Label htmlFor="websiteEmbedAllowedOrigins" className="text-foreground">Allowed websites</Label>
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
            <p className="text-xs text-muted-foreground">
              The chat widget will only appear on these websites. List one address per line, starting with <code>https://</code>.
            </p>
          </div>

          <details className="group mt-5 rounded-xl border border-border bg-background/60 p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Translations</p>
                <p className="text-xs text-muted-foreground">
                  Spanish, French, German, Italian, Portuguese, Dutch, Polish, Chinese, Japanese, and Russian are built in — only add a translation here if you want to override the wording.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {Object.keys(anonSettings.websiteEmbedCopy ?? {}).length > 0 ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Active
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Optional</span>
                )}
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
              </div>
            </summary>

            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="websiteEmbedCopyLocale" className="text-foreground">Language code</Label>
                <Input
                  id="websiteEmbedCopyLocale"
                  value={websiteEmbedCopyLocale}
                  onChange={(event) => setWebsiteEmbedCopyLocale(event.target.value)}
                  placeholder="en, it, fr-CA"
                />
                <p className="text-xs text-muted-foreground">
                  Use the short language code (e.g. <code>en</code> for English, <code>it</code> for Italian, <code>fr-CA</code> for Canadian French).
                </p>
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

          <details className="group mt-3 rounded-xl border border-border bg-background/60 p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Get visitors&apos; attention</p>
                <p className="text-xs text-muted-foreground">
                  Add a subtle animation or a friendly greeting message above the chat button so visitors notice it.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {hasWebsiteEmbedAdvancedOverrides ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Active
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Optional</span>
                )}
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-open:rotate-180" />
              </div>
            </summary>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {displayMode === 'bubble' ? (
                <div className="space-y-2">
                  <Label htmlFor="websiteEmbedExpert-launcherAttention" className="text-foreground">Animation style</Label>
                  <select
                    id="websiteEmbedExpert-launcherAttention"
                    value={anonSettings.websiteEmbedExpertOverrides?.launcherAttention ?? ''}
                    onChange={(event) => handleWebsiteEmbedExpertOverrideChange('launcherAttention', event.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                  >
                    {ATTENTION_OPTIONS.map(({ value, label }) => (
                      <option key={value || 'none'} value={value}>{label}</option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    A subtle motion on the chat button to catch the eye. Stops automatically once a visitor opens the chat.
                  </p>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="websiteEmbedExpert-proactiveGreetingTeaser" className="text-foreground">Greeting message</Label>
                <Input
                  id="websiteEmbedExpert-proactiveGreetingTeaser"
                  value={anonSettings.websiteEmbedExpertOverrides?.proactiveGreetingTeaser ?? ''}
                  onChange={(event) => handleWebsiteEmbedExpertOverrideChange('proactiveGreetingTeaser', event.target.value)}
                  placeholder="Hi! How can I help?"
                />
                <p className="text-xs text-muted-foreground">
                  A small speech bubble pops up above the chat button with this message. Requires the assistant&apos;s <em>Proactive greeting</em> to be turned on.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="websiteEmbedExpert-launcherTeaserDelaySeconds" className="text-foreground">Show greeting after</Label>
                <div className="relative">
                  <Input
                    id="websiteEmbedExpert-launcherTeaserDelaySeconds"
                    value={(() => {
                      const stored = anonSettings.websiteEmbedExpertOverrides?.launcherTeaserDelayMs
                      if (!stored) return ''
                      const parsed = parseInt(stored, 10)
                      return Number.isFinite(parsed) ? String(parsed / 1000) : ''
                    })()}
                    onChange={(event) => {
                      const raw = event.target.value.trim()
                      if (!raw) {
                        handleWebsiteEmbedExpertOverrideChange('launcherTeaserDelayMs', '')
                        return
                      }
                      const seconds = parseFloat(raw)
                      if (!Number.isFinite(seconds) || seconds < 0) {
                        return
                      }
                      handleWebsiteEmbedExpertOverrideChange('launcherTeaserDelayMs', String(Math.round(seconds * 1000)))
                    }}
                    placeholder="4"
                    className="pr-20"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
                    seconds
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  How long the page is open before the greeting appears. Defaults to 4 seconds.
                </p>
              </div>
            </div>
          </details>

          {anonSettings.websiteEmbedEnabled ? (
            <div className="mt-5 space-y-3 rounded-xl bg-muted/50 p-4">
              <div className="flex items-center gap-2 text-foreground">
                <Code2 className="h-4 w-4" />
                <Label className="text-foreground">Add this to your website</Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Copy this code and paste it into your website&apos;s HTML, just before the closing <code>&lt;/body&gt;</code> tag. If you&apos;re not sure how, send it to whoever maintains the site.
              </p>

              {websiteEmbedSnippet ? (
                <CodeBlock code={websiteEmbedSnippet} language="html" className="my-0" />
              ) : (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  Fix the errors above to generate the code.
                </div>
              )}
              {websiteEmbedDemoError ? (
                <p className="text-xs text-destructive">{websiteEmbedDemoError}</p>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleWebsiteEmbedTokenRotate}
                  disabled={isAnonSaving}
                  className="text-muted-foreground hover:text-foreground"
                  title="Generates a new install code. Any existing installations will stop working until you paste the new code."
                >
                  {isAnonSaving ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                  Generate new code
                </Button>
                <Button
                  variant="default"
                  onClick={handleOpenWebsiteEmbedDemo}
                  disabled={
                    isAnonSaving ||
                    isPreparingWebsiteEmbedDemo ||
                    !anonSettings.websiteEmbedEnabled ||
                    !websiteEmbedDemoUrl
                  }
                  title="Saves your current settings and opens a sample page where you can try the widget right away."
                >
                  {isPreparingWebsiteEmbedDemo ? (
                    <Spinner className="mr-2 h-4 w-4" />
                  ) : (
                    <ExternalLink className="mr-2 h-4 w-4" />
                  )}
                  Try it on a demo page
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
