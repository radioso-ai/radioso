'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Building2, Code2, ExternalLink, FolderOpen, Globe, KeyRound, MessageSquare, RefreshCw, ShieldAlert, Sparkles, Trash2 } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { Button } from '@/components/ui/button'
import { CopyValueField } from '@/components/ui/copy-value-field'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { getApiErrorMessage } from '@/lib/api-error'
import { accountApi, generalSettingsApi, settingsApi, type GeneralSettings, type RetrievalSettings } from '@/lib/api'
import {
  APP_WEBSITE_EMBED_DEMO_PATH,
  DEFAULT_WEBSITE_EMBED_THEME,
  buildWebsiteEmbedTestHarnessUrl,
  buildWebsiteEmbedSnippet,
  formatWebsiteEmbedOrigins,
  normalizeWebsiteEmbedAvatarUrl,
  normalizeWebsiteEmbedDisplayMode,
  normalizeWebsiteEmbedInitialState,
  normalizeWebsiteEmbedLocale,
  parseWebsiteEmbedJsonOverrides,
  parseWebsiteEmbedOrigins,
  sanitizeWebsiteEmbedCopyOverrides,
  sanitizeWebsiteEmbedThemeOverrides,
} from '@/lib/embed-widget'
import { useWorkspace } from '@/lib/workspace-context'

type JsonOverrideRecord = Record<string, unknown>

const getWebsiteEmbedJsonOverrideRecord = (value: string): JsonOverrideRecord => {
  const parsed = parseWebsiteEmbedJsonOverrides(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  return { ...(parsed as JsonOverrideRecord) }
}

const stringifyWebsiteEmbedJsonOverrideRecord = (value: JsonOverrideRecord) =>
  Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : ''

const getOrganizationNameCacheKey = (accountId: string) => `radioso.organizationName:${accountId}`

export const ASSISTANT_GREETING_LOCALE_OPTIONS = [
  { label: 'English', tag: 'en' },
  { label: 'Italian', tag: 'it' },
  { label: 'Spanish', tag: 'es' },
  { label: 'French', tag: 'fr' },
  { label: 'German', tag: 'de' },
  { label: 'Portuguese', tag: 'pt' },
  { label: 'Dutch', tag: 'nl' },
  { label: 'Swedish', tag: 'sv' },
  { label: 'Norwegian', tag: 'no' },
  { label: 'Danish', tag: 'da' },
  { label: 'Finnish', tag: 'fi' },
  { label: 'Estonian', tag: 'et' },
  { label: 'Russian', tag: 'ru' },
  { label: 'Japanese', tag: 'ja' },
  { label: 'Korean', tag: 'ko' },
  { label: 'Chinese', tag: 'zh' },
] as const

export const NO_GREETING_LOCALE_LABEL = 'No fallback'

export const getAssistantLocaleLabel = (tag: string | null) => {
  if (!tag) {
    return NO_GREETING_LOCALE_LABEL
  }

  return ASSISTANT_GREETING_LOCALE_OPTIONS.find((option) => option.tag === tag)?.label ?? `Custom locale: ${tag}`
}

export const resolveAssistantLocaleInput = (value: string) => {
  const trimmed = value.trim()
  const normalized = trimmed.toLowerCase()
  if (!trimmed || normalized === NO_GREETING_LOCALE_LABEL.toLowerCase()) {
    return null
  }

  const configuredOption = ASSISTANT_GREETING_LOCALE_OPTIONS.find(
    (option) => option.label.toLowerCase() === normalized || option.tag.toLowerCase() === normalized,
  )
  if (configuredOption) {
    return configuredOption.tag
  }

  return normalizeWebsiteEmbedLocale(trimmed) ?? undefined
}

const readCachedOrganizationName = (accountId: string) => {
  if (typeof window === 'undefined') {
    return ''
  }

  const cachedValue = window.localStorage.getItem(getOrganizationNameCacheKey(accountId))
  return typeof cachedValue === 'string' ? cachedValue : ''
}

const writeCachedOrganizationName = (accountId: string, organizationName: string) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(getOrganizationNameCacheKey(accountId), organizationName)
}

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

const assistantConversationModeLabels: Record<
  RetrievalSettings['conversationMode'],
  { label: string; description: string }
> = {
  factual: {
    label: 'Factual',
    description: 'Answer the current question directly and stop unless clarification is required.',
  },
  guided: {
    label: 'Guided',
    description: 'Answer directly, then suggest one or two grounded nearby directions when useful.',
  },
  exploratory: {
    label: 'Exploratory',
    description: 'Answer directly, then surface more of what the workspace covers and invite grounded follow-up.',
  },
}

export function WorkspaceAssistantChannelsTab({
  accountId,
  mode,
  onSaveStateChange,
}: {
  accountId: string
  mode: 'workspace' | 'assistant' | 'channels'
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const { activeWorkspaceId, activeWorkspace, workspaces, renameWorkspace, deleteWorkspace, isLoading: isWorkspaceLoading } = useWorkspace()
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState<string | null>(null)
  const [organizationName, setOrganizationName] = useState(() => readCachedOrganizationName(accountId))
  const [savedOrganizationName, setSavedOrganizationName] = useState(() => readCachedOrganizationName(accountId))
  const [isOrganizationLoading, setIsOrganizationLoading] = useState(true)
  const [organizationError, setOrganizationError] = useState<string | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const workspaceName = workspaceNameDraft ?? activeWorkspace?.name ?? ''
  const hasNameChange = workspaceNameDraft !== null && workspaceName.trim() !== (activeWorkspace?.name ?? '')
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [rotateApiTokenDialogOpen, setRotateApiTokenDialogOpen] = useState(false)
  const [isRotatingApiToken, setIsRotatingApiToken] = useState(false)
  const [rotateApiTokenError, setRotateApiTokenError] = useState<string | null>(null)
  const isLastWorkspace = workspaces.length <= 1
  const deleteConfirmValid = deleteConfirmName === activeWorkspace?.name
  const [anonSettings, setAnonSettings] = useState<GeneralSettings | null>(null)
  const [savedAnonSettings, setSavedAnonSettings] = useState<GeneralSettings | null>(null)
  const [isAnonLoading, setIsAnonLoading] = useState(true)
  const [isAnonSaving, setIsAnonSaving] = useState(false)
  const [assistantBehaviorSettings, setAssistantBehaviorSettings] = useState<RetrievalSettings | null>(null)
  const [savedAssistantBehaviorSettings, setSavedAssistantBehaviorSettings] = useState<RetrievalSettings | null>(null)
  const [isAssistantBehaviorLoading, setIsAssistantBehaviorLoading] = useState(mode === 'assistant')
  const { setSaveState, setSaveError, saveSequenceRef } = useSettingsSaveStatus(onSaveStateChange)
  const [websiteEmbedOrigins, setWebsiteEmbedOrigins] = useState('')
  const [websiteEmbedSnippetDisplayMode, setWebsiteEmbedSnippetDisplayMode] = useState('')
  const [websiteEmbedSnippetInitialState, setWebsiteEmbedSnippetInitialState] = useState('')
  const [websiteEmbedSnippetAvatarUrl, setWebsiteEmbedSnippetAvatarUrl] = useState('')
  const [websiteEmbedSnippetCopyJson, setWebsiteEmbedSnippetCopyJson] = useState('')
  const [websiteEmbedSnippetThemeJson, setWebsiteEmbedSnippetThemeJson] = useState('')
  const [isPreparingWebsiteEmbedDemo, setIsPreparingWebsiteEmbedDemo] = useState(false)
  const [websiteEmbedDemoError, setWebsiteEmbedDemoError] = useState<string | null>(null)
  const [assistantSettingsError, setAssistantSettingsError] = useState<string | null>(null)
  const [assistantLocaleInput, setAssistantLocaleInput] = useState(NO_GREETING_LOCALE_LABEL)
  const [apiToken, setApiToken] = useState<string | null>(null)
  const [apiTokenError, setApiTokenError] = useState<string | null>(null)
  const [isApiTokenLoading, setIsApiTokenLoading] = useState(false)
  const organizationDraftVersionRef = useRef(0)
  const workspaceDraftVersionRef = useRef(0)
  const anonDraftVersionRef = useRef(0)
  const assistantBehaviorDraftVersionRef = useRef(0)

  useEffect(() => {
    let active = true

    const loadOrganization = async () => {
      setIsOrganizationLoading(true)
      try {
        const response = await accountApi.listAccounts()
        if (!active) return
        const current = response.accounts.find((account) => account.accountId === accountId)
        const nextOrganizationName = current?.organizationName ?? ''
        setOrganizationName(nextOrganizationName)
        setSavedOrganizationName(nextOrganizationName)
        writeCachedOrganizationName(accountId, nextOrganizationName)
        setOrganizationError(null)
      } catch {
        if (!active) return
        setOrganizationError('Failed to load organization')
      } finally {
        if (active) {
          setIsOrganizationLoading(false)
        }
      }
    }

    void loadOrganization()
    return () => {
      active = false
    }
  }, [accountId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Workspace switch invalidates token rotation UI state.
    setApiToken(null)
    setApiTokenError(null)
    setIsApiTokenLoading(false)
    setRotateApiTokenDialogOpen(false)
    setRotateApiTokenError(null)
    setIsRotatingApiToken(false)
  }, [activeWorkspaceId])

  useEffect(() => {
    if (isWorkspaceLoading || !activeWorkspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Workspace changes reset channel settings loading state.
      setIsAnonLoading(true)
      return
    }

    let active = true
    setIsAnonLoading(true)
    const loadAnonSettings = async () => {
      try {
        const data = await generalSettingsApi.getGeneralSettings()
        if (!active) return
        setAnonSettings(data)
        setSavedAnonSettings(data)
        setAssistantLocaleInput(getAssistantLocaleLabel(data.assistantDefaultLocale))
        setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(data.websiteEmbedAllowedOrigins ?? []))
        setAssistantSettingsError(null)
      } catch (error) {
        if (!active) return
        console.error('Failed to load anonymous chat settings:', error)
      } finally {
        if (active) {
          setIsAnonLoading(false)
        }
      }
    }
    void loadAnonSettings()
    return () => {
      active = false
    }
  }, [activeWorkspaceId, isWorkspaceLoading])

  useEffect(() => {
    if (mode !== 'assistant') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Leaving assistant mode clears assistant-only draft state.
      setAssistantBehaviorSettings(null)
      setSavedAssistantBehaviorSettings(null)
      setIsAssistantBehaviorLoading(false)
      return
    }

    if (isWorkspaceLoading || !activeWorkspaceId) {
      setIsAssistantBehaviorLoading(true)
      return
    }

    let active = true
    setIsAssistantBehaviorLoading(true)
    const loadAssistantBehaviorSettings = async () => {
      try {
        const data = await settingsApi.getRetrievalSettings()
        if (!active) return
        setAssistantBehaviorSettings(data)
        setSavedAssistantBehaviorSettings(data)
        setAssistantSettingsError(null)
      } catch (error) {
        if (!active) return
        console.error('Failed to load assistant behavior settings:', error)
        setAssistantSettingsError(getApiErrorMessage(error, 'Failed to load assistant settings.'))
      } finally {
        if (active) {
          setIsAssistantBehaviorLoading(false)
        }
      }
    }

    void loadAssistantBehaviorSettings()
    return () => {
      active = false
    }
  }, [activeWorkspaceId, isWorkspaceLoading, mode])

  const handleAnonToggle = async (enabled: boolean) => {
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        anonymousChatEnabled: enabled,
        anonymousRateLimit: anonSettings?.anonymousRateLimit ?? 10,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
    } catch (error) {
      console.error('Failed to update anonymous chat settings:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleAnonRateLimitChange = (value: number) => {
    if (!anonSettings) return
    setAnonSettings({ ...anonSettings, anonymousRateLimit: value })
  }

  const handleAnonRateLimitCommit = async (value: number) => {
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        anonymousChatEnabled: anonSettings?.anonymousChatEnabled ?? false,
        anonymousRateLimit: value,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
    } catch (error) {
      console.error('Failed to update rate limit:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!activeWorkspace || !deleteConfirmValid) return
    setIsDeleting(true)
    try {
      await deleteWorkspace(activeWorkspace.id)
      setDeleteDialogOpen(false)
      setDeleteConfirmName('')
    } catch {
      setIsDeleting(false)
    }
  }

  const handleRevealApiToken = async () => {
    if (!activeWorkspaceId) return
    setIsApiTokenLoading(true)
    setApiTokenError(null)
    try {
      const response = await accountApi.getWorkspaceToken(activeWorkspaceId)
      setApiToken(response.token)
    } catch (error) {
      console.error('Failed to reveal workspace token:', error)
      setApiTokenError('Failed to reveal the workspace token')
    } finally {
      setIsApiTokenLoading(false)
    }
  }

  const handleRotateApiToken = async () => {
    if (!activeWorkspaceId) return

    setIsRotatingApiToken(true)
    setRotateApiTokenError(null)

    try {
      const response = await accountApi.rotateWorkspaceToken(activeWorkspaceId)
      setApiToken(response.token)
      setRotateApiTokenDialogOpen(false)
    } catch (error) {
      console.error('Failed to rotate workspace token:', error)
      setRotateApiTokenError(getApiErrorMessage(error, 'Failed to rotate the workspace token.'))
    } finally {
      setIsRotatingApiToken(false)
    }
  }

  const apiAccessExample = useMemo(() => {
    const apiBasePath = process.env.NEXT_PUBLIC_API_BASE_PATH ?? '/backend/api/v1'
    const origin = typeof window === 'undefined' ? 'https://your-radioso-host' : window.location.origin
    return `curl ${origin}${apiBasePath}/settings/retrieval \\\n  -H "Authorization: Bearer <token>"`
  }, [])

  const handleAssistantSettingChange = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) => {
    if (!anonSettings) return
    anonDraftVersionRef.current += 1
    setAssistantSettingsError(null)
    setAnonSettings({ ...anonSettings, [key]: value })
  }

  const handleAssistantLocaleInputChange = (value: string) => {
    setAssistantLocaleInput(value)
    const resolvedLocale = resolveAssistantLocaleInput(value)
    if (resolvedLocale !== undefined) {
      handleAssistantSettingChange('assistantDefaultLocale', resolvedLocale)
    }
  }

  const updateAssistantBehaviorDraft = (updater: (current: RetrievalSettings) => RetrievalSettings) => {
    assistantBehaviorDraftVersionRef.current += 1
    setAssistantBehaviorSettings((current) => (current ? updater(current) : current))
  }

  const hasAssistantChanges =
    anonSettings && savedAnonSettings
      ? (
          anonSettings.assistantName !== savedAnonSettings.assistantName ||
          anonSettings.assistantDefaultLocale !== savedAnonSettings.assistantDefaultLocale ||
          anonSettings.proactiveGreetingEnabled !== savedAnonSettings.proactiveGreetingEnabled
        )
      : false

  const hasAssistantBehaviorChanges =
    assistantBehaviorSettings && savedAssistantBehaviorSettings
      ? (
	          assistantBehaviorSettings.conversationMode !== savedAssistantBehaviorSettings.conversationMode ||
	          assistantBehaviorSettings.customInstruction !== savedAssistantBehaviorSettings.customInstruction ||
	          assistantBehaviorSettings.suggestedQuestionsEnabled !== savedAssistantBehaviorSettings.suggestedQuestionsEnabled ||
	          assistantBehaviorSettings.suggestedQuestionsCount !== savedAssistantBehaviorSettings.suggestedQuestionsCount
	        )
	      : false

  const hasWebsiteEmbedChanges =
    anonSettings && savedAnonSettings
      ? (
          anonSettings.websiteEmbedEnabled !== savedAnonSettings.websiteEmbedEnabled ||
          websiteEmbedOrigins !== formatWebsiteEmbedOrigins(savedAnonSettings.websiteEmbedAllowedOrigins ?? []) ||
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
    const fallbackEmbeddedChatTitle = anonSettings?.assistantName?.trim() || activeWorkspace?.name?.trim()
    if (!fallbackEmbeddedChatTitle || websiteEmbedSnippetCopyOverrides.embeddedChatTitle) {
      return websiteEmbedSnippetCopyOverrides
    }

    return {
      ...websiteEmbedSnippetCopyOverrides,
      embeddedChatTitle: fallbackEmbeddedChatTitle,
    }
  }, [activeWorkspace?.name, anonSettings?.assistantName, websiteEmbedSnippetCopyOverrides])

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
      new URL(APP_WEBSITE_EMBED_DEMO_PATH, window.location.origin).toString(),
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

  const websiteEmbedHasLocalHarnessOrigin = useMemo(
    () => (websiteEmbedDemoOrigin ? parseWebsiteEmbedOrigins(websiteEmbedOrigins).includes(websiteEmbedDemoOrigin) : false),
    [websiteEmbedDemoOrigin, websiteEmbedOrigins],
  )

  useEffect(() => {
    if (!accountId || isOrganizationLoading) {
      return
    }
    const trimmed = organizationName.trim()
    if (trimmed === '' || trimmed === savedOrganizationName) {
      return
    }
    const timeout = window.setTimeout(async () => {
      if (trimmed.length > 80) {
        setOrganizationError('Organization name must be between 1 and 80 characters')
        setSaveState('error')
        setSaveError('Failed to save changes')
        return
      }
      const draftVersionAtRequestStart = organizationDraftVersionRef.current
      const saveId = saveSequenceRef.current + 1
      saveSequenceRef.current = saveId
      setSaveState('saving')
      setSaveError(null)
      setOrganizationError(null)
      try {
        const updated = await accountApi.renameOrganization(trimmed)
        if (saveSequenceRef.current !== saveId) return
        setSavedOrganizationName(updated.organizationName)
        writeCachedOrganizationName(accountId, updated.organizationName)
        if (organizationDraftVersionRef.current === draftVersionAtRequestStart) {
          setOrganizationName(updated.organizationName)
          setSaveState('saved')
        }
        window.dispatchEvent(new Event('radioso:accounts-updated'))
      } catch {
        if (saveSequenceRef.current !== saveId) return
        setOrganizationError('Failed to rename organization')
        setSaveState('error')
        setSaveError('Failed to save changes')
      }
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [accountId, isOrganizationLoading, organizationName, saveSequenceRef, savedOrganizationName, setSaveError, setSaveState])

  useEffect(() => {
    if (!activeWorkspace || !hasNameChange) {
      return
    }
    const trimmed = workspaceName.trim()
    const timeout = window.setTimeout(async () => {
      if (!trimmed || trimmed.length > 100) {
        setRenameError('Name must be between 1 and 100 characters')
        setSaveState('error')
        setSaveError('Failed to save changes')
        return
      }
      const draftVersionAtRequestStart = workspaceDraftVersionRef.current
      const saveId = saveSequenceRef.current + 1
      saveSequenceRef.current = saveId
      setSaveState('saving')
      setSaveError(null)
      setRenameError(null)
      try {
        await renameWorkspace(activeWorkspace.id, trimmed)
        if (saveSequenceRef.current !== saveId) return
        if (workspaceDraftVersionRef.current === draftVersionAtRequestStart) {
          setWorkspaceNameDraft(null)
          setSaveState('saved')
        }
      } catch {
        if (saveSequenceRef.current !== saveId) return
        setRenameError('Failed to rename workspace')
        setSaveState('error')
        setSaveError('Failed to save changes')
      }
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [activeWorkspace, hasNameChange, renameWorkspace, saveSequenceRef, setSaveError, setSaveState, workspaceName])

  useEffect(() => {
    if (!anonSettings || !savedAnonSettings || !hasAssistantChanges) {
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
        const updated = await generalSettingsApi.updateGeneralSettings({
          assistantName: anonSettings.assistantName,
          assistantDefaultLocale: anonSettings.assistantDefaultLocale,
          proactiveGreetingEnabled: anonSettings.proactiveGreetingEnabled,
        })
        if (saveSequenceRef.current !== saveId) return
        setSavedAnonSettings(updated)
        setAssistantSettingsError(null)
        if (anonDraftVersionRef.current === draftVersionAtRequestStart) {
          setAnonSettings(updated)
          setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
          setSaveState('saved')
        }
      } catch (error) {
        if (saveSequenceRef.current !== saveId) return
        console.error('Failed to update assistant settings:', error)
        setAssistantSettingsError(getApiErrorMessage(error, 'Failed to update assistant settings.'))
        setSaveState('error')
        setSaveError('Failed to save changes')
      } finally {
        if (saveSequenceRef.current === saveId) {
          setIsAnonSaving(false)
        }
      }
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [anonSettings, hasAssistantChanges, saveSequenceRef, savedAnonSettings, setSaveError, setSaveState])

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
        const updated = await generalSettingsApi.updateGeneralSettings({
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
          setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
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
  }, [anonSettings, hasWebsiteEmbedChanges, saveSequenceRef, savedAnonSettings, setSaveError, setSaveState, websiteEmbedOrigins])

  useEffect(() => {
    if (!assistantBehaviorSettings || !savedAssistantBehaviorSettings || !hasAssistantBehaviorChanges) {
      return
    }

    const timeout = window.setTimeout(async () => {
      const draftVersionAtRequestStart = assistantBehaviorDraftVersionRef.current
      const saveId = saveSequenceRef.current + 1
      saveSequenceRef.current = saveId
      setSaveState('saving')
      setSaveError(null)
      try {
        const updated = await settingsApi.updateRetrievalSettings(assistantBehaviorSettings)
        if (saveSequenceRef.current !== saveId) return
        setSavedAssistantBehaviorSettings(updated)
        setAssistantSettingsError(null)
        if (assistantBehaviorDraftVersionRef.current === draftVersionAtRequestStart) {
          setAssistantBehaviorSettings(updated)
          setSaveState('saved')
        }
      } catch (error) {
        if (saveSequenceRef.current !== saveId) return
        console.error('Failed to update assistant behavior settings:', error)
        setAssistantSettingsError(getApiErrorMessage(error, 'Failed to update assistant settings.'))
        setSaveState('error')
        setSaveError('Failed to save changes')
      }
    }, 700)

    return () => window.clearTimeout(timeout)
  }, [assistantBehaviorSettings, hasAssistantBehaviorChanges, saveSequenceRef, savedAssistantBehaviorSettings, setSaveError, setSaveState])

  const handleOpenWebsiteEmbedDemo = async () => {
    if (!anonSettings?.websiteEmbedEnabled || !websiteEmbedDemoUrl || typeof window === 'undefined') {
      return
    }

    setIsPreparingWebsiteEmbedDemo(true)
    setWebsiteEmbedDemoError(null)

    try {
      const parsedOrigins = parseWebsiteEmbedOrigins(websiteEmbedOrigins)
      const nextOrigins = websiteEmbedHasLocalHarnessOrigin
        ? parsedOrigins
        : websiteEmbedDemoOrigin
          ? [...parsedOrigins, websiteEmbedDemoOrigin]
          : parsedOrigins

      const hasPersistedChanges =
        !websiteEmbedHasLocalHarnessOrigin ||
        anonSettings.websiteEmbedEnabled !== (savedAnonSettings?.websiteEmbedEnabled ?? false) ||
        websiteEmbedOrigins !== formatWebsiteEmbedOrigins(savedAnonSettings?.websiteEmbedAllowedOrigins ?? []) ||
        anonSettings.websiteEmbedLauncherLabel !== savedAnonSettings?.websiteEmbedLauncherLabel ||
        anonSettings.websiteEmbedLauncherIcon !== savedAnonSettings?.websiteEmbedLauncherIcon ||
        anonSettings.websiteEmbedLauncherPosition !== savedAnonSettings?.websiteEmbedLauncherPosition

      if (hasPersistedChanges) {
        const updated = await generalSettingsApi.updateGeneralSettings({
          websiteEmbedEnabled: anonSettings.websiteEmbedEnabled ?? false,
          websiteEmbedAllowedOrigins: nextOrigins,
          websiteEmbedLauncherLabel: anonSettings.websiteEmbedLauncherLabel ?? 'Chat with us',
          websiteEmbedLauncherIcon: anonSettings.websiteEmbedLauncherIcon ?? 'chat',
          websiteEmbedLauncherPosition: anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right',
        })
        setAnonSettings(updated)
        setSavedAnonSettings(updated)
        setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
      }

      window.open(websiteEmbedDemoUrl, '_blank', 'noopener,noreferrer')
    } catch (error) {
      console.error('Failed to prepare website embed demo page:', error)
      setWebsiteEmbedDemoError(getApiErrorMessage(error, 'Failed to prepare the local demo page.'))
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

  const handleAnonymousChatTokenRotate = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        rotateAnonymousChatToken: true,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
    } catch (error) {
      console.error('Failed to rotate anonymous chat token:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleWebsiteEmbedTokenRotate = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        rotateWebsiteEmbedToken: true,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setWebsiteEmbedOrigins(formatWebsiteEmbedOrigins(updated.websiteEmbedAllowedOrigins ?? []))
    } catch (error) {
      console.error('Failed to rotate website embed token:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  return (
    <SettingsTabShell>
      <div className="space-y-8">
        {mode === 'workspace' ? (
        <section id="workspace-access" className="space-y-6 scroll-mt-24">
            <SettingsCard
              icon={<Building2 className="h-5 w-5 text-primary" />}
              title="Organization name"
              description="Label shown in the organization picker and invite flows."
            >
              <div className="space-y-2">
                <Input
                  value={organizationName}
                  onChange={(event) => {
                    organizationDraftVersionRef.current += 1
                    setOrganizationName(event.target.value)
                    setOrganizationError(null)
                  }}
                  maxLength={80}
                  className="flex-1"
                  placeholder={isOrganizationLoading ? 'Loading organization name…' : undefined}
                />
                {organizationError ? <p className="text-sm text-destructive">{organizationError}</p> : null}
              </div>
            </SettingsCard>

            <SettingsCard
              icon={<FolderOpen className="h-5 w-5 text-primary" />}
              title="Workspace name"
              description="Internal workspace label used in the dashboard, workspace switcher, and admin tools."
            >
              <div className="space-y-2">
                <Input
                  id="workspaceName"
                  value={workspaceName}
                  onChange={(event) => {
                    const nextName = event.target.value
                    workspaceDraftVersionRef.current += 1
                    setWorkspaceNameDraft(nextName === (activeWorkspace?.name ?? '') ? null : nextName)
                    setRenameError(null)
                  }}
                  maxLength={100}
                  className="flex-1"
                />
                {renameError ? <p className="text-sm text-destructive">{renameError}</p> : null}
              </div>
            </SettingsCard>

            <SettingsCard
              icon={<KeyRound className="h-5 w-5 text-primary" />}
              title="API access"
              description="Use this workspace token for API calls and SDK clients."
            >
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  The dashboard uses your signed-in session. External clients should authenticate with the workspace
                  token below.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRevealApiToken}
                    disabled={!activeWorkspaceId || isApiTokenLoading}
                  >
                    {isApiTokenLoading ? <Spinner className="mr-2" /> : null}
                    Reveal API token
                  </Button>
                  {apiToken ? (
                    <Button size="sm" variant="ghost" onClick={() => setApiToken(null)}>
                      Hide token
                    </Button>
                  ) : null}
                </div>
                {apiToken ? (
                  <CopyValueField value={apiToken} ariaLabel="Copy API token" wrap className="w-full" />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Reveal the token only when you need to copy it into another client.
                  </p>
                )}
                {apiTokenError ? <p className="text-sm text-destructive">{apiTokenError}</p> : null}
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Example</p>
                  <code className="block overflow-x-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-3 text-sm font-mono text-foreground">
                    {apiAccessExample}
                  </code>
                </div>
              </div>
            </SettingsCard>

        </section>
        ) : null}

          {mode === 'assistant' ? (
          <section id="assistant-identity" className="space-y-6 scroll-mt-24">
            {isAnonLoading || isAssistantBehaviorLoading ? (
              <div className="flex items-center justify-center py-4">
                <LogoSpinner imageClassName="h-6 w-6" />
              </div>
            ) : anonSettings && assistantBehaviorSettings ? (
              <SettingsCard
                icon={<Sparkles className="h-5 w-5 text-primary" />}
                title="Assistant behavior"
                description="Public identity, answer behavior, and first-message defaults."
              >
                {assistantSettingsError ? (
                  <p className="text-sm text-destructive" role="alert">{assistantSettingsError}</p>
                ) : null}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="assistantName" className="text-foreground">Assistant name</Label>
                    <Input
                      id="assistantName"
                      value={anonSettings.assistantName}
                      maxLength={200}
                      onChange={(event) => handleAssistantSettingChange('assistantName', event.target.value)}
                      placeholder="e.g. Marta"
                    />
                    <p className="text-xs text-muted-foreground">
                      Visible chat title in Public Chat and Website Embed. Falls back to the workspace name when left blank.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="assistantDefaultLocale" className="text-foreground">Greeting language fallback</Label>
                    <Input
                      id="assistantDefaultLocale"
                      list="assistant-greeting-locale-options"
                      value={assistantLocaleInput}
                      onChange={(event) => handleAssistantLocaleInputChange(event.target.value)}
                      placeholder="Search for a language"
                    />
                    <datalist id="assistant-greeting-locale-options">
                      <option value={NO_GREETING_LOCALE_LABEL} />
                      {ASSISTANT_GREETING_LOCALE_OPTIONS.map((option) => (
                        <option key={option.tag} value={option.label} />
                      ))}
                    </datalist>
                    <p className="text-xs text-muted-foreground">
                      Used only for the automatic first greeting when the chat or embed does not provide a language. Normal replies follow the user’s message language.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="assistantAnswerInstruction" className="text-foreground">Answer instruction</Label>
                  <Textarea
                    id="assistantAnswerInstruction"
                    value={assistantBehaviorSettings.customInstruction}
                    onChange={(event) =>
                      updateAssistantBehaviorDraft((current) => ({
                        ...current,
                        customInstruction: event.target.value.slice(0, 2000),
                      }))
                    }
                    placeholder="e.g. Help visitors choose the right course. Be concise, practical, and concrete."
                    rows={4}
                  />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Purpose, scope, tone, and answer guidance applied to responses.</span>
                    <span>{assistantBehaviorSettings.customInstruction.length} / 2000</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="assistantConversationMode" className="text-foreground">Conversation mode</Label>
                  <select
                    id="assistantConversationMode"
                    value={assistantBehaviorSettings.conversationMode}
                    onChange={(event) =>
                      updateAssistantBehaviorDraft((current) => ({
                        ...current,
                        conversationMode: event.target.value as RetrievalSettings['conversationMode'],
                      }))
                    }
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
                  >
                    {Object.entries(assistantConversationModeLabels).map(([value, meta]) => (
                      <option key={value} value={value}>
                        {meta.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-sm text-muted-foreground">
                    {assistantConversationModeLabels[assistantBehaviorSettings.conversationMode].description}
                  </p>
                </div>

	                <div className="flex flex-col gap-4 rounded bg-muted/50 p-3 sm:flex-row sm:items-start sm:justify-between">
	                  <div className="min-w-0">
	                    <Label htmlFor="assistantSuggestedQuestionsEnabled" className="text-foreground">Suggested follow-up questions</Label>
	                    <p className="text-sm text-muted-foreground mt-0.5">
	                      Show grounded follow-up chips after assistant answers when useful.
	                    </p>
	                  </div>
	                  <Switch
	                    id="assistantSuggestedQuestionsEnabled"
	                    checked={assistantBehaviorSettings.suggestedQuestionsEnabled}
	                    onCheckedChange={(checked) =>
	                      updateAssistantBehaviorDraft((current) => ({
	                        ...current,
	                        suggestedQuestionsEnabled: checked,
	                      }))
	                    }
	                  />
	                </div>

	                {assistantBehaviorSettings.suggestedQuestionsEnabled ? (
	                  <div className="space-y-3 rounded bg-muted/50 p-3">
	                    <div className="flex items-center justify-between gap-4">
	                      <div>
	                        <Label htmlFor="assistantSuggestedQuestionsCount" className="text-foreground">Maximum follow-up questions</Label>
	                        <p className="text-sm text-muted-foreground mt-0.5">
	                          This is a cap. The assistant can return fewer when the evidence supports fewer useful continuations.
	                        </p>
	                      </div>
	                      <span className="text-sm font-mono text-muted-foreground">{assistantBehaviorSettings.suggestedQuestionsCount}</span>
	                    </div>
	                    <Slider
	                      id="assistantSuggestedQuestionsCount"
	                      min={1}
	                      max={4}
	                      step={1}
	                      value={[assistantBehaviorSettings.suggestedQuestionsCount]}
	                      onValueChange={(value) =>
	                        updateAssistantBehaviorDraft((current) => ({
	                          ...current,
	                          suggestedQuestionsCount: value[0] ?? 1,
	                        }))
	                      }
	                    />
	                  </div>
	                ) : null}

	                <div className="flex flex-col gap-4 rounded bg-muted/50 p-3 sm:flex-row sm:items-start sm:justify-between">
	                  <div className="min-w-0">
	                    <Label htmlFor="proactiveGreetingEnabled" className="text-foreground">Proactive first greeting</Label>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Whether a brand-new chat begins with an assistant-first greeting.
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Status: {anonSettings.assistantBootstrapActive ? 'active' : 'inactive until assistant name is configured'}
                    </p>
                  </div>
                  <Switch
                    id="proactiveGreetingEnabled"
                    checked={anonSettings.proactiveGreetingEnabled}
                    onCheckedChange={(checked) => handleAssistantSettingChange('proactiveGreetingEnabled', checked)}
                    disabled={isAnonSaving}
                  />
                </div>
              </SettingsCard>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load assistant settings.</p>
            )}
          </section>
          ) : null}

          {mode === 'channels' && isAnonLoading ? (
          <section className="flex min-h-[320px] items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading ? (
          <section id="anonymous-chat" className="space-y-6 scroll-mt-24">
            {anonSettings ? (
              <section className="scroll-mt-24 rounded-2xl border border-border bg-card/95 p-5 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
                      <MessageSquare className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-medium text-foreground">Anonymous chat</h3>
                      <p className="text-sm text-muted-foreground">
                        Public link access for unauthenticated visitors.
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="anonChatToggle"
                    checked={anonSettings.anonymousChatEnabled}
                    onCheckedChange={handleAnonToggle}
                    disabled={isAnonSaving}
                    className="sm:mt-3"
                  />
                </div>

                {anonSettings.anonymousChatEnabled && anonSettings.anonymousChatUrl ? (
                  <div className="mt-5 space-y-5">
                    <div className="space-y-2">
                      <Label htmlFor="anonChatUrl" className="text-foreground">Public Chat URL</Label>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                        <CopyValueField
                          value={anonSettings.anonymousChatUrl}
                          ariaLabel="Copy URL"
                          className="min-w-0 flex-1"
                          wrap
                        />
                        <Button asChild className="bg-blue-600 text-white hover:bg-blue-500 sm:self-start">
                          <a href={anonSettings.anonymousChatUrl} target="_blank" rel="noreferrer">
                            <ExternalLink className="w-4 h-4" />
                            Try the chat
                          </a>
                        </Button>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Anyone with this link can open the assistant.
                      </p>
                      <div className="flex justify-end">
                        <Button variant="outline" onClick={handleAnonymousChatTokenRotate} disabled={isAnonSaving}>
                          {isAnonSaving ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                          Rotate public link
                        </Button>
                      </div>
                    </div>

                    <div className="rounded bg-muted/50 p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="anonRateLimit" className="text-foreground">Rate Limit</Label>
                        <span className="text-sm font-mono text-muted-foreground">
                          {anonSettings.anonymousRateLimit} msg/min
                        </span>
                      </div>
                      <Slider
                        id="anonRateLimit"
                        min={1}
                        max={60}
                        step={1}
                        value={[anonSettings.anonymousRateLimit]}
                        onValueChange={([value]) => handleAnonRateLimitChange(value)}
                        onValueCommit={([value]) => handleAnonRateLimitCommit(value)}
                        disabled={isAnonSaving}
                      />
                      <p className="text-sm text-muted-foreground">
                        Maximum messages per minute for each anonymous user session.
                      </p>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load anonymous chat settings.</p>
            )}
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading ? (
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
                    onCheckedChange={(checked) => handleAssistantSettingChange('websiteEmbedEnabled', checked)}
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
                      onChange={(event) => handleAssistantSettingChange('websiteEmbedLauncherLabel', event.target.value)}
                      placeholder="Chat with us"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="websiteEmbedLauncherPosition" className="text-foreground">Launcher position</Label>
                    <select
                      id="websiteEmbedLauncherPosition"
                      value={anonSettings.websiteEmbedLauncherPosition ?? 'bottom-right'}
                      onChange={(event) =>
                        handleAssistantSettingChange('websiteEmbedLauncherPosition', event.target.value as GeneralSettings['websiteEmbedLauncherPosition'])
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
                      handleAssistantSettingChange('websiteEmbedLauncherIcon', event.target.value as GeneralSettings['websiteEmbedLauncherIcon'])
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
                      Quick local tryout: this action saves the current website embed settings, adds the current app origin to the approved origins when needed, and opens a same-origin demo page prefilled with the current widget configuration.
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
                        Open local demo page
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
              <p className="text-sm text-muted-foreground">Failed to load website embed settings.</p>
            )}
          </section>
          ) : null}

          {mode === 'workspace' ? (
          <section>
            <SettingsCard
              icon={<ShieldAlert className="h-5 w-5 text-destructive" />}
              iconClassName="border-destructive/20 bg-destructive/10"
              className="border-destructive/50"
              title="Danger zone"
              description="Permanent workspace actions that cannot be undone."
            >
            <div className="flex flex-col gap-4 border-b border-destructive/20 pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Rotate workspace API token</p>
                <p className="text-sm text-muted-foreground">
                  Immediately revoke the current token and issue a new one for this workspace. Any scripts, SDK
                  clients, or automations using the current token will need to be updated.
                </p>
              </div>

              <Dialog
                open={rotateApiTokenDialogOpen}
                onOpenChange={(open) => {
                  setRotateApiTokenDialogOpen(open)
                  if (!open) {
                    setRotateApiTokenError(null)
                    setIsRotatingApiToken(false)
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="sm:self-start">
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Rotate token
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Rotate workspace API token</DialogTitle>
                    <DialogDescription>
                      The current workspace token will stop working immediately. Any scripts, SDK clients, or
                      automations using it must be updated to the new token.
                    </DialogDescription>
                  </DialogHeader>
                  {rotateApiTokenError ? (
                    <p className="text-sm text-destructive">{rotateApiTokenError}</p>
                  ) : null}
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setRotateApiTokenDialogOpen(false)}
                      disabled={isRotatingApiToken}
                    >
                      Cancel
                    </Button>
                    <Button variant="destructive" onClick={handleRotateApiToken} disabled={isRotatingApiToken}>
                      {isRotatingApiToken ? <Spinner className="mr-2" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                      Rotate token
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Delete this workspace</p>
                <p className="text-sm text-muted-foreground">
                  Permanently delete this workspace and all its documents, chats, and settings. This action cannot be undone.
                </p>
              </div>

              <Dialog
                open={deleteDialogOpen}
                onOpenChange={(open) => {
                  setDeleteDialogOpen(open)
                  if (!open) {
                    setDeleteConfirmName('')
                    setIsDeleting(false)
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="sm:self-start"
                    disabled={isLastWorkspace}
                    title={isLastWorkspace ? 'Cannot delete the last workspace' : undefined}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete workspace</DialogTitle>
                    <DialogDescription>
                      This will permanently delete the workspace <strong>{activeWorkspace?.name}</strong> and
                      all its documents, conversations, and settings. This action cannot be undone.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2 py-2">
                    <Label htmlFor="deleteConfirm" className="text-foreground">
                      Type <strong>{activeWorkspace?.name}</strong> to confirm
                    </Label>
                    <Input
                      id="deleteConfirm"
                      value={deleteConfirmName}
                      onChange={(event) => setDeleteConfirmName(event.target.value)}
                      placeholder={activeWorkspace?.name}
                    />
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={!deleteConfirmValid || isDeleting}
                    >
                      {isDeleting ? <Spinner className="mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
                      Delete workspace
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>

            {isLastWorkspace ? (
              <p className="text-sm text-muted-foreground">
                You cannot delete your only workspace. Create another workspace first.
              </p>
            ) : null}
            </SettingsCard>
          </section>
          ) : null}

      </div>
    </SettingsTabShell>
  )
}
