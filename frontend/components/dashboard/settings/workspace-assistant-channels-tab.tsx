'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Building2, ExternalLink, FolderOpen, KeyRound, Mail, MessageSquare, RefreshCw, ShieldAlert, Sparkles, Trash2, UserRound, Webhook } from 'lucide-react'

import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { WebsiteEmbedSettingsController } from '@/components/dashboard/settings/website-embed-settings-controller'
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
import {
  accountApi,
  generalSettingsApi,
  humanContactApi,
  settingsApi,
  type GeneralSettings,
  type HumanContactAvailability,
  type RetrievalSettings,
} from '@/lib/api'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { editionController } from '@/lib/edition-controller'
import { normalizeLocaleTag } from '@/lib/locale'
import { useWorkspace } from '@/lib/workspace-context'

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

  return normalizeLocaleTag(trimmed) ?? undefined
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

const isValidHumanContactWebhookUrl = (value: string) => {
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return false
  }

  try {
    const url = new URL(trimmedValue)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const isValidHumanContactEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
const MCP_SERVER_URL = 'http://127.0.0.1:8787/mcp'
const MCP_ASSISTANT_TOOL_NAME = 'chat_with_assistant'
const MCP_TOKEN_EXCHANGE_COMMAND = `source <(
  RADIOSO_WORKSPACE_TOKEN=radioso_... \\
  npm --prefix packages/radioso-mcp-server run -s token:exchange
)`
const MCP_CURSOR_CONFIG = `{
  "mcpServers": {
    "radioso": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer \${env:RADIOSO_MCP_ACCESS_TOKEN}"
      }
    }
  }
}`

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
  const [humanContactSettings, setHumanContactSettings] = useState<HumanContactAvailability | null>(null)
  const [savedHumanContactSettings, setSavedHumanContactSettings] = useState<HumanContactAvailability | null>(null)
  const [humanContactSigningSecret, setHumanContactSigningSecret] = useState('')
  const [isHumanContactSecretLoading, setIsHumanContactSecretLoading] = useState(false)
  const [isHumanContactLoading, setIsHumanContactLoading] = useState(false)
  const [isHumanContactSaving, setIsHumanContactSaving] = useState(false)
  const [humanContactError, setHumanContactError] = useState<string | null>(null)
  const [assistantBehaviorSettings, setAssistantBehaviorSettings] = useState<RetrievalSettings | null>(null)
  const [savedAssistantBehaviorSettings, setSavedAssistantBehaviorSettings] = useState<RetrievalSettings | null>(null)
  const [isAssistantBehaviorLoading, setIsAssistantBehaviorLoading] = useState(mode === 'assistant')
  const { setSaveState, setSaveError, saveSequenceRef } = useSettingsSaveStatus(onSaveStateChange)
  const [assistantSettingsError, setAssistantSettingsError] = useState<string | null>(null)
  const [assistantLocaleInput, setAssistantLocaleInput] = useState(NO_GREETING_LOCALE_LABEL)
  const [apiToken, setApiToken] = useState<string | null>(null)
  const [apiTokenError, setApiTokenError] = useState<string | null>(null)
  const [isApiTokenLoading, setIsApiTokenLoading] = useState(false)
  const organizationDraftVersionRef = useRef(0)
  const workspaceDraftVersionRef = useRef(0)
  const anonDraftVersionRef = useRef(0)
  const assistantBehaviorDraftVersionRef = useRef(0)
  const workspaceTokenSettingsHref = activeWorkspace
    ? buildDashboardHref(accountId, {
        section: 'settings',
        workspaceId: activeWorkspace.id,
        workspacePublicRouteKey: activeWorkspace.publicRouteKey,
        anchor: 'workspace-access',
      })
    : buildDashboardHref(accountId, { section: 'settings', anchor: 'workspace-access' })

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

  useEffect(() => {
    if (!editionController.shouldLoadHumanContactSettings(mode)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Leaving channels mode clears Enterprise-only channel draft state.
      setHumanContactSettings(null)
      setSavedHumanContactSettings(null)
      setHumanContactSigningSecret('')
      setHumanContactError(null)
      setIsHumanContactLoading(false)
      return
    }

    if (isWorkspaceLoading || !activeWorkspaceId) {
      setIsHumanContactLoading(true)
      return
    }

    let active = true
    setIsHumanContactLoading(true)
    const loadHumanContactSettings = async () => {
      try {
        const settings = await humanContactApi.getSettings()
        if (!active) return
        setHumanContactSettings(settings)
        setSavedHumanContactSettings(settings)
        setHumanContactSigningSecret('')
        setHumanContactError(null)
      } catch (error) {
        if (!active) return
        setHumanContactSettings(null)
        setSavedHumanContactSettings(null)
        setHumanContactError(getApiErrorMessage(error, 'Talk to a human is not available in this build.'))
      } finally {
        if (active) {
          setIsHumanContactLoading(false)
        }
      }
    }

    void loadHumanContactSettings()
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
    } catch (error) {
      console.error('Failed to update anonymous chat settings:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleMcpAssistantToggle = async (enabled: boolean) => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        mcpAssistantAccessEnabled: enabled,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
    } catch (error) {
      console.error('Failed to update MCP assistant access:', error)
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

  const hasHumanContactChanges =
    humanContactSettings && savedHumanContactSettings
      ? (
          humanContactSettings.enabled !== savedHumanContactSettings.enabled ||
          Boolean(humanContactSettings.emailEnabled) !== Boolean(savedHumanContactSettings.emailEnabled) ||
          (humanContactSettings.defaultEmail ?? '') !== (savedHumanContactSettings.defaultEmail ?? '') ||
          Boolean(humanContactSettings.webhookEnabled) !== Boolean(savedHumanContactSettings.webhookEnabled) ||
          (humanContactSettings.webhookUrl ?? '') !== (savedHumanContactSettings.webhookUrl ?? '')
        )
      : false

  const humanContactEmailEnabled = Boolean(humanContactSettings?.emailEnabled)
  const humanContactDefaultEmail = humanContactSettings?.defaultEmail ?? ''
  const humanContactDefaultEmailTrimmed = humanContactDefaultEmail.trim()
  const humanContactDefaultEmailInvalid =
    humanContactDefaultEmailTrimmed.length > 0 && !isValidHumanContactEmail(humanContactDefaultEmailTrimmed)
  const humanContactMissingEmail =
    Boolean(humanContactSettings?.enabled) && humanContactEmailEnabled && humanContactDefaultEmailTrimmed.length === 0
  const humanContactWebhookEnabled = Boolean(humanContactSettings?.webhookEnabled)
  const humanContactWebhookUrl = humanContactSettings?.webhookUrl ?? ''
  const humanContactWebhookUrlTrimmed = humanContactWebhookUrl.trim()
  const humanContactWebhookUrlInvalid =
    humanContactWebhookUrlTrimmed.length > 0 && !isValidHumanContactWebhookUrl(humanContactWebhookUrlTrimmed)
  const humanContactMissingWebhook =
    Boolean(humanContactSettings?.enabled) && humanContactWebhookEnabled && humanContactWebhookUrlTrimmed.length === 0
  const humanContactMissingDelivery =
    Boolean(humanContactSettings?.enabled) && !humanContactEmailEnabled && !humanContactWebhookEnabled
  const canSaveHumanContact =
    Boolean(humanContactSettings) &&
    hasHumanContactChanges &&
    !isHumanContactSaving &&
    !humanContactMissingDelivery &&
    !humanContactMissingEmail &&
    !humanContactDefaultEmailInvalid &&
    !humanContactMissingWebhook &&
    !humanContactWebhookUrlInvalid

  const updateHumanContactDraft = (patch: Partial<HumanContactAvailability>) => {
    setHumanContactError(null)
    setHumanContactSettings((current) => (current ? { ...current, ...patch } : current))
  }

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
        window.dispatchEvent(new CustomEvent('radioso:assistant-name-updated', {
          detail: { assistantName: updated.assistantName },
        }))
        if (anonDraftVersionRef.current === draftVersionAtRequestStart) {
          setAnonSettings(updated)
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

  const handleAnonymousChatTokenRotate = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = await generalSettingsApi.updateGeneralSettings({
        rotateAnonymousChatToken: true,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
    } catch (error) {
      console.error('Failed to rotate anonymous chat token:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleSaveHumanContactSettings = async () => {
    if (!humanContactSettings || !canSaveHumanContact) {
      return
    }

    setIsHumanContactSaving(true)
    setHumanContactError(null)
    setSaveState('saving')
    setSaveError(null)

    try {
      const updated = await humanContactApi.updateSettings({
        enabled: humanContactSettings.enabled,
        emailEnabled: humanContactEmailEnabled,
        defaultEmail: humanContactEmailEnabled && humanContactDefaultEmailTrimmed ? humanContactDefaultEmailTrimmed : null,
        webhookEnabled: humanContactWebhookEnabled,
        webhookUrl: humanContactWebhookEnabled && humanContactWebhookUrlTrimmed ? humanContactWebhookUrlTrimmed : null,
      })
      setHumanContactSettings(updated)
      setSavedHumanContactSettings(updated)
      setHumanContactSigningSecret('')
      setSaveState('saved')
    } catch (error) {
      console.error('Failed to update human contact settings:', error)
      const message = getApiErrorMessage(error, 'Failed to save human contact settings.')
      setHumanContactError(message)
      setSaveState('error')
      setSaveError(message)
    } finally {
      setIsHumanContactSaving(false)
    }
  }

  const handleRotateHumanContactSecret = async () => {
    if (!humanContactSettings || isHumanContactSaving) {
      return
    }

    setIsHumanContactSaving(true)
    setHumanContactError(null)
    setSaveState('saving')
    setSaveError(null)

    try {
      const updated = await humanContactApi.updateSettings({
        enabled: humanContactSettings.enabled,
        emailEnabled: humanContactEmailEnabled,
        defaultEmail: humanContactEmailEnabled && humanContactDefaultEmailTrimmed ? humanContactDefaultEmailTrimmed : null,
        webhookEnabled: humanContactWebhookEnabled,
        webhookUrl: humanContactWebhookEnabled && humanContactWebhookUrlTrimmed ? humanContactWebhookUrlTrimmed : null,
        rotateSigningSecret: true,
      })
      setHumanContactSettings(updated)
      setSavedHumanContactSettings(updated)
      setHumanContactSigningSecret('')
      setSaveState('saved')
    } catch (error) {
      console.error('Failed to rotate talk to a human signing token:', error)
      const message = getApiErrorMessage(error, 'Failed to rotate the signing token.')
      setHumanContactError(message)
      setSaveState('error')
      setSaveError(message)
    } finally {
      setIsHumanContactSaving(false)
    }
  }

  const handleRevealHumanContactSecret = async () => {
    if (!humanContactSettings?.signingSecretConfigured) {
      return
    }

    setIsHumanContactSecretLoading(true)
    setHumanContactError(null)
    try {
      const response = await humanContactApi.revealSigningSecret()
      setHumanContactSigningSecret(response.signingSecret ?? '')
    } catch (error) {
      console.error('Failed to reveal talk to a human signing token:', error)
      setHumanContactError(getApiErrorMessage(error, 'Failed to reveal the signing token.'))
    } finally {
      setIsHumanContactSecretLoading(false)
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
                  <CopyValueField value={apiToken} ariaLabel="Copy API token" className="w-full" />
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
                      Visible chat title in public chat. Falls back to the workspace name when left blank.
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
                      Used only for the automatic first greeting when the chat does not provide a language. Normal replies follow the user’s message language.
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
          <section id="mcp-assistant" className="space-y-6 scroll-mt-24">
            {anonSettings ? (
              <section className="scroll-mt-24 rounded-2xl border border-border bg-card/95 p-5 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
                      <Sparkles className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-medium text-foreground">MCP assistant access</h3>
                      <p className="text-sm text-muted-foreground">
                        Let MCP clients call this assistant through the Radioso MCP server.
                      </p>
                    </div>
                  </div>
                  <Switch
                    id="mcpAssistantAccessToggle"
                    checked={anonSettings.mcpAssistantAccessEnabled}
                    onCheckedChange={handleMcpAssistantToggle}
                    disabled={isAnonSaving}
                    className="sm:mt-3"
                  />
                </div>

                <div className="mt-5 space-y-5">
                  <div className="rounded bg-muted/50 p-3 text-sm text-muted-foreground">
                    Status:{' '}
                    <span className="font-medium text-foreground">
                      {anonSettings.mcpAssistantAccessEnabled ? 'enabled' : 'off'}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    When enabled, MCP clients can use the assistant persona, instructions, retrieval behavior, citations,
                    and normal assistant history. Retrieval-only MCP tools stay available separately.
                  </p>

                  {anonSettings.mcpAssistantAccessEnabled ? (
                    <div className="space-y-4">
                      <div className="grid gap-4 lg:grid-cols-2">
                        <div className="space-y-2">
                          <Label className="text-foreground">MCP server URL</Label>
                          <CopyValueField value={MCP_SERVER_URL} ariaLabel="Copy MCP server URL" wrap className="w-full" />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-foreground">Assistant tool</Label>
                          <CopyValueField value={MCP_ASSISTANT_TOOL_NAME} ariaLabel="Copy MCP assistant tool name" wrap className="w-full" />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <Label className="text-foreground">Workspace token prerequisite</Label>
                          <Button asChild size="sm" variant="outline">
                            <a href={workspaceTokenSettingsHref}>Open API token settings</a>
                          </Button>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Exchange a workspace token for a short-lived MCP access token before configuring your client.
                        </p>
                        <CopyValueField value={MCP_TOKEN_EXCHANGE_COMMAND} ariaLabel="Copy MCP token exchange command" wrap className="w-full" />
                      </div>

                      <div className="space-y-2">
                        <Label className="text-foreground">Cursor URL-mode config</Label>
                        <CopyValueField value={MCP_CURSOR_CONFIG} ariaLabel="Copy Cursor MCP config" wrap className="w-full" />
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}
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

          {editionController.canUseHumanContact() && mode === 'channels' && !isAnonLoading ? (
          <section id="human-contact" className="space-y-6 scroll-mt-24">
            <section className="scroll-mt-24 rounded-2xl border border-border bg-card/95 p-5 shadow-sm">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
                    <UserRound className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-medium text-foreground">Talk to a human</h3>
                    <p className="text-sm text-muted-foreground">
                      Let visitors ask for a person from chat and public chat.
                    </p>
                  </div>
                </div>
                <Switch
                  id="humanContactToggle"
                  checked={humanContactSettings?.enabled ?? false}
                  onCheckedChange={(checked) => updateHumanContactDraft({ enabled: checked })}
                  disabled={isHumanContactLoading || isHumanContactSaving || !humanContactSettings}
                  className="sm:mt-3"
                />
              </div>

              {isHumanContactLoading ? (
                <div className="flex items-center justify-center py-8">
                  <LogoSpinner imageClassName="h-6 w-6" />
                </div>
              ) : humanContactSettings ? (
                <div className="mt-5 space-y-5">
                  <div className="rounded bg-muted/50 p-3 text-sm text-muted-foreground">
                    Status:{' '}
                    <span className="font-medium text-foreground">
                      {!humanContactSettings.enabled
                        ? 'off'
                        : humanContactDefaultEmailInvalid || humanContactWebhookUrlInvalid
                          ? 'fix validation errors'
                          : humanContactMissingDelivery
                            ? 'choose email or webhook'
                            : humanContactMissingEmail
                              ? 'add an email address'
                              : humanContactMissingWebhook
                                ? 'add a webhook URL'
                                : hasHumanContactChanges
                                  ? 'ready after saving'
                            : humanContactSettings.configured
                              ? 'ready'
                              : 'not configured'}
                    </span>
                  </div>

                  {humanContactSettings.enabled ? (
                    <>
                      <div className="space-y-3">
                        <div className="rounded-lg border border-border bg-background/60 p-4">
                          <div className="flex items-start gap-3">
                            <Mail className="mt-0.5 h-5 w-5 text-primary" />
                            <div className="min-w-0 flex-1 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <Label htmlFor="humanContactEmailToggle" className="text-sm font-medium text-foreground">
                                  Email
                                </Label>
                                <Switch
                                  id="humanContactEmailToggle"
                                  checked={humanContactEmailEnabled}
                                  onCheckedChange={(checked) => updateHumanContactDraft({ emailEnabled: checked })}
                                  disabled={isHumanContactSaving}
                                />
                              </div>
                              {humanContactEmailEnabled ? (
                                <div className="space-y-2">
                                  <Label htmlFor="humanContactDefaultEmail" className="text-foreground">Default email</Label>
                                  <Input
                                    id="humanContactDefaultEmail"
                                    type="email"
                                    value={humanContactDefaultEmail}
                                    onChange={(event) => updateHumanContactDraft({ defaultEmail: event.target.value })}
                                    placeholder="support@example.com"
                                    disabled={isHumanContactSaving}
                                  />
                                  {humanContactDefaultEmailInvalid ? (
                                    <p className="text-xs text-destructive">Enter a valid email address.</p>
                                  ) : (
                                    <p className="text-xs text-muted-foreground">
                                      Requests are emailed here after they are saved.
                                    </p>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        <div className="rounded-lg border border-border bg-background/60 p-4">
                          <div className="flex items-start gap-3">
                            <Webhook className="mt-0.5 h-5 w-5 text-primary" />
                            <div className="min-w-0 flex-1 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <Label htmlFor="humanContactWebhookToggle" className="text-sm font-medium text-foreground">
                                  Webhook
                                </Label>
                                <Switch
                                  id="humanContactWebhookToggle"
                                  checked={humanContactWebhookEnabled}
                                  onCheckedChange={(checked) => updateHumanContactDraft({ webhookEnabled: checked })}
                                  disabled={isHumanContactSaving}
                                />
                              </div>
                              {humanContactWebhookEnabled ? (
                                <div className="grid gap-4 md:grid-cols-2">
                                  <div className="space-y-2">
                                    <Label htmlFor="humanContactWebhookUrl" className="text-foreground">Webhook URL</Label>
                                    <Input
                                      id="humanContactWebhookUrl"
                                      type="url"
                                      value={humanContactWebhookUrl}
                                      onChange={(event) => updateHumanContactDraft({ webhookUrl: event.target.value })}
                                      placeholder="https://support.example.com/radioso/talk-to-human"
                                      disabled={isHumanContactSaving}
                                    />
                                    {humanContactWebhookUrlInvalid ? (
                                      <p className="text-xs text-destructive">Enter a valid http(s) webhook URL.</p>
                                    ) : (
                                      <p className="text-xs text-muted-foreground">
                                        Radioso sends each request to this endpoint.
                                      </p>
                                    )}
                                  </div>

                                  <div className="space-y-2">
                                    <Label className="text-foreground">Signing token</Label>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={handleRevealHumanContactSecret}
                                        disabled={isHumanContactSaving || isHumanContactSecretLoading || !humanContactSettings.signingSecretConfigured}
                                      >
                                        {isHumanContactSecretLoading ? <Spinner className="mr-2 h-4 w-4" /> : null}
                                        Reveal token
                                      </Button>
                                      {humanContactSigningSecret ? (
                                        <Button size="sm" variant="ghost" onClick={() => setHumanContactSigningSecret('')}>
                                          Hide token
                                        </Button>
                                      ) : null}
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={handleRotateHumanContactSecret}
                                        disabled={isHumanContactSaving || humanContactWebhookUrlInvalid || !humanContactSettings.signingSecretConfigured}
                                      >
                                        {isHumanContactSaving ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                                        Rotate token
                                      </Button>
                                    </div>
                                    {humanContactSigningSecret ? (
                                      <CopyValueField value={humanContactSigningSecret} ariaLabel="Copy signing token" className="w-full" />
                                    ) : (
                                      <p className="text-xs text-muted-foreground">
                                        {humanContactSettings.signingSecretConfigured
                                          ? 'Reveal the token only when you need to verify webhook signatures.'
                                          : 'A signing token will be generated after saving webhook setup.'}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>

                      {humanContactMissingDelivery ? (
                        <p className="text-sm text-destructive">Choose Email or Webhook before saving.</p>
                      ) : null}
                      {humanContactMissingEmail ? (
                        <p className="text-sm text-destructive">Add a default email address.</p>
                      ) : null}
                      {humanContactMissingWebhook ? (
                        <p className="text-sm text-destructive">Add a webhook URL.</p>
                      ) : null}
                    </>
                  ) : null}

                  {humanContactError ? (
                    <p className="text-sm text-destructive" role="alert">{humanContactError}</p>
                  ) : null}

                  <div className="flex justify-end">
                    <Button onClick={handleSaveHumanContactSettings} disabled={!canSaveHumanContact}>
                      {isHumanContactSaving ? <Spinner className="mr-2 h-4 w-4" /> : null}
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-5 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  Talk to a human is available only when the Enterprise module is installed.
                  {humanContactError ? (
                    <p className="mt-2 text-destructive" role="alert">{humanContactError}</p>
                  ) : null}
                </div>
              )}
            </section>
          </section>
          ) : null}


          <WebsiteEmbedSettingsController
            mode={mode}
            activeWorkspaceName={activeWorkspace?.name}
            anonSettings={anonSettings}
            savedAnonSettings={savedAnonSettings}
            setAnonSettings={setAnonSettings}
            setSavedAnonSettings={setSavedAnonSettings}
            isAnonSaving={isAnonSaving}
            setIsAnonSaving={setIsAnonSaving}
            anonDraftVersionRef={anonDraftVersionRef}
            saveSequenceRef={saveSequenceRef}
            setSaveState={setSaveState}
            setSaveError={setSaveError}
          />

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
