'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Building2, CheckCircle2, CircleAlert, ExternalLink, FolderOpen, KeyRound, Link as LinkIcon, Mail, RefreshCw, ShieldAlert, Trash2, UserRound, Webhook } from 'lucide-react'

import { AssistantBehaviorSection } from '@/components/dashboard/settings/assistant-behavior-section'
import {
  getAssistantLocaleLabel,
  NO_GREETING_LOCALE_LABEL,
  resolveAssistantLocaleInput,
} from '@/components/dashboard/settings/assistant-locale-options'
import { DEFAULT_ASSISTANT_THEME } from '@/components/dashboard/settings/assistant-theme-form-helpers'
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
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  accountApi,
  agentsApi,
  documentsApi,
  generalSettingsApi,
  humanContactApi,
  type AssistantBehaviorSettings,
  type AccountMembershipRole,
  type DocumentSourceListItem,
  type GeneralSettings,
  type HumanContactAvailability,
} from '@/lib/api'
import { editionController } from '@/lib/edition-controller'
import { isValidEmailAddress } from '@/lib/validation'
import { useWorkspace } from '@/lib/workspace-context'

const getOrganizationNameCacheKey = (accountId: string) => `radioso.organizationName:${accountId}`

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

type GeneralSettingsUpdateInput = Parameters<typeof generalSettingsApi.updateGeneralSettings>[0]

const normalizeAssistantBehaviorSettingsByAgent = (agentId: string | undefined, settings: AssistantBehaviorSettings) => ({
  ...settings,
  sourceScope: agentId ? settings.sourceScope ?? { mode: 'all' } : undefined,
})

const getAssistantBehaviorSourceScopeKey = (settings: AssistantBehaviorSettings) => {
  const sourceScope = settings.sourceScope ?? { mode: 'all' as const }
  if (sourceScope.mode === 'all') {
    return 'all'
  }

  return `selected:${[...new Set(sourceScope.sourceIds)].sort().join('\0')}`
}

export function WorkspaceAssistantChannelsTab({
  accountId,
  mode,
  agentId,
  channelsTabHref,
  onSaveStateChange,
}: {
  accountId: string
  mode: 'workspace' | 'assistant' | 'channels'
  agentId?: string
  channelsTabHref?: string
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const { activeWorkspaceId, activeWorkspace, workspaces, renameWorkspace, deleteWorkspace, isLoading: isWorkspaceLoading } = useWorkspace()
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState<string | null>(null)
  const [organizationName, setOrganizationName] = useState(() => readCachedOrganizationName(accountId))
  const [savedOrganizationName, setSavedOrganizationName] = useState(() => readCachedOrganizationName(accountId))
  const [currentAccountRole, setCurrentAccountRole] = useState<AccountMembershipRole | null>(null)
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
  const [assistantBehaviorSettings, setAssistantBehaviorSettings] = useState<AssistantBehaviorSettings | null>(null)
  const [savedAssistantBehaviorSettings, setSavedAssistantBehaviorSettings] = useState<AssistantBehaviorSettings | null>(null)
  const [sourceList, setSourceList] = useState<DocumentSourceListItem[]>([])
  const [sourceListError, setSourceListError] = useState<string | null>(null)
  const [isSourceListLoading, setIsSourceListLoading] = useState(false)
  const [isAssistantBehaviorLoading, setIsAssistantBehaviorLoading] = useState(mode === 'assistant')
  const [isAssistantLogoSaving, setIsAssistantLogoSaving] = useState(false)
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
  const humanContactDraftVersionRef = useRef(0)
  const canManageOrganization = currentAccountRole === 'owner' || currentAccountRole === 'admin'
  const canManageWorkspaceLifecycle = currentAccountRole === 'owner' || currentAccountRole === 'admin'
  const canReadWorkspaceTokens = Boolean(currentAccountRole)
  const canRotateWorkspaceTokens = currentAccountRole === 'owner' || currentAccountRole === 'admin'

  const loadGeneralSettings = useCallback(async () => {
    return agentId ? agentsApi.getGeneralSettings(agentId) : generalSettingsApi.getGeneralSettings({ auth: 'session' })
  }, [agentId])

  const updateGeneralSettings = useCallback(async (data: GeneralSettingsUpdateInput) => {
    return agentId ? agentsApi.updateGeneralSettings(agentId, data) : generalSettingsApi.updateGeneralSettings(data, { auth: 'session' })
  }, [agentId])

  const rotateWebsiteEmbedToken = useCallback(async () => {
    return agentId ? agentsApi.rotateWebsiteEmbedToken(agentId) : generalSettingsApi.rotateWebsiteEmbedToken({ auth: 'session' })
  }, [agentId])

  const uploadAssistantLogo = useCallback(async (file: File) => {
    return agentId ? agentsApi.uploadAssistantLogo(agentId, file) : generalSettingsApi.uploadAssistantLogo(file, { auth: 'session' })
  }, [agentId])

  const deleteAssistantLogo = useCallback(async () => {
    return agentId ? agentsApi.deleteAssistantLogo(agentId) : generalSettingsApi.deleteAssistantLogo({ auth: 'session' })
  }, [agentId])

  const loadAssistantBehaviorSettings = useCallback(async () => {
    return agentId ? agentsApi.getBehaviorSettings(agentId) : agentsApi.getWorkspaceBehaviorSettings({ auth: 'session' })
  }, [agentId])

  const updateAssistantBehaviorSettings = useCallback(async (data: AssistantBehaviorSettings) => {
    return agentId ? agentsApi.updateBehaviorSettings(agentId, data) : agentsApi.updateWorkspaceBehaviorSettings(data, { auth: 'session' })
  }, [agentId])

  useEffect(() => {
    let active = true

    const loadOrganization = async () => {
      setIsOrganizationLoading(true)
      try {
        const response = await accountApi.listAccounts()
        if (!active) return
        const current = response.accounts.find((account) => account.accountId === accountId)
        const nextOrganizationName = current?.organizationName ?? ''
        setCurrentAccountRole(current?.role ?? null)
        setOrganizationName(nextOrganizationName)
        setSavedOrganizationName(nextOrganizationName)
        writeCachedOrganizationName(accountId, nextOrganizationName)
        setOrganizationError(null)
      } catch {
        if (!active) return
        setCurrentAccountRole(null)
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
        const data = await loadGeneralSettings()
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
  }, [activeWorkspaceId, agentId, isWorkspaceLoading, loadGeneralSettings])

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
    const loadAssistantBehaviorSettingsEffect = async () => {
      try {
        const data = await loadAssistantBehaviorSettings()
        if (!active) return
        const normalized = normalizeAssistantBehaviorSettingsByAgent(agentId, data)
        setAssistantBehaviorSettings(normalized)
        setSavedAssistantBehaviorSettings(normalized)
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

    void loadAssistantBehaviorSettingsEffect()
    return () => {
      active = false
    }
  }, [activeWorkspaceId, agentId, isWorkspaceLoading, loadAssistantBehaviorSettings, mode])

  useEffect(() => {
    let active = true
    const loadSources = async () => {
      if (mode !== 'assistant' || !agentId || isWorkspaceLoading || !activeWorkspaceId) {
        setSourceList([])
        setSourceListError(null)
        setIsSourceListLoading(false)
        return
      }

      setIsSourceListLoading(true)
      try {
        const response = await documentsApi.listSources()
        if (!active) return
        setSourceList(response.sources)
        setSourceListError(null)
      } catch (error) {
        if (!active) return
        console.error('Failed to load document sources:', error)
        setSourceList([])
        setSourceListError(getApiErrorMessage(error, 'Failed to load sources.'))
      } finally {
        if (active) {
          setIsSourceListLoading(false)
        }
      }
    }

    void loadSources()
    return () => {
      active = false
    }
  }, [activeWorkspaceId, agentId, isWorkspaceLoading, mode])

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
        setHumanContactError(getApiErrorMessage(error, 'Contact handoff is not available in this build.'))
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
      const updated = await updateGeneralSettings({
        anonymousChatEnabled: enabled,
      })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
    } catch (error) {
      console.error('Failed to update anonymous chat settings:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!activeWorkspace || !deleteConfirmValid || !canManageWorkspaceLifecycle) return
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
    if (!activeWorkspaceId || !canReadWorkspaceTokens) return
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
    if (!activeWorkspaceId || !canRotateWorkspaceTokens) return

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

  const updateAssistantBehaviorDraft = (updater: (current: AssistantBehaviorSettings) => AssistantBehaviorSettings) => {
    assistantBehaviorDraftVersionRef.current += 1
    setAssistantBehaviorSettings((current) => (current ? updater(current) : current))
  }

  const handleAssistantLogoUpload = async (file: File | null) => {
    if (!file) return
    setIsAssistantLogoSaving(true)
    setSaveState('saving')
    setSaveError(null)
    try {
      const updated = await uploadAssistantLogo(file)
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setSaveState('saved')
    } catch (error) {
      const message = getApiErrorMessage(error, 'Failed to upload assistant logo')
      console.error('Failed to upload assistant logo:', error)
      setSaveState('error')
      setSaveError(message)
    } finally {
      setIsAssistantLogoSaving(false)
    }
  }

  const handleAssistantLogoDelete = async () => {
    setIsAssistantLogoSaving(true)
    setSaveState('saving')
    setSaveError(null)
    try {
      const updated = await deleteAssistantLogo()
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
      setSaveState('saved')
    } catch (error) {
      const message = getApiErrorMessage(error, 'Failed to remove assistant logo')
      console.error('Failed to remove assistant logo:', error)
      setSaveState('error')
      setSaveError(message)
    } finally {
      setIsAssistantLogoSaving(false)
    }
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
          assistantBehaviorSettings.customInstruction !== savedAssistantBehaviorSettings.customInstruction ||
          assistantBehaviorSettings.suggestedQuestionsEnabled !== savedAssistantBehaviorSettings.suggestedQuestionsEnabled ||
          getAssistantBehaviorSourceScopeKey(assistantBehaviorSettings) !==
            getAssistantBehaviorSourceScopeKey(savedAssistantBehaviorSettings) ||
          JSON.stringify(assistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME) !==
            JSON.stringify(savedAssistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME)
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
    humanContactDefaultEmailTrimmed.length > 0 && !isValidEmailAddress(humanContactDefaultEmailTrimmed)
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
  const updateHumanContactSettingsDraft = (patch: Partial<HumanContactAvailability>) => {
    humanContactDraftVersionRef.current += 1
    setHumanContactError(null)
    setHumanContactSettings((current) => (current ? { ...current, ...patch } : current))
  }

  useEffect(() => {
    if (!accountId || isOrganizationLoading || !canManageOrganization) {
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
  }, [accountId, canManageOrganization, isOrganizationLoading, organizationName, saveSequenceRef, savedOrganizationName, setSaveError, setSaveState])

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
        const updated = await updateGeneralSettings({
          assistantName: anonSettings.assistantName,
          assistantDefaultLocale: anonSettings.assistantDefaultLocale,
          proactiveGreetingEnabled: anonSettings.proactiveGreetingEnabled,
        })
        if (saveSequenceRef.current !== saveId) return
        const nameChanged = savedAnonSettings.assistantName !== updated.assistantName
        setSavedAnonSettings(updated)
        setAssistantSettingsError(null)
        if (nameChanged) {
          window.dispatchEvent(new CustomEvent('radioso:assistant-name-updated', {
            detail: { assistantName: updated.assistantName },
          }))
        }
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
  }, [anonSettings, hasAssistantChanges, saveSequenceRef, savedAnonSettings, setSaveError, setSaveState, updateGeneralSettings])

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
        const updated = normalizeAssistantBehaviorSettingsByAgent(
          agentId,
          await updateAssistantBehaviorSettings(assistantBehaviorSettings),
        )
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
  }, [agentId, assistantBehaviorSettings, hasAssistantBehaviorChanges, saveSequenceRef, savedAssistantBehaviorSettings, setSaveError, setSaveState, updateAssistantBehaviorSettings])

  const handleAnonymousChatTokenRotate = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    try {
      const updated = agentId
        ? await agentsApi.rotateAnonymousChatToken(agentId)
        : await generalSettingsApi.rotateAnonymousChatToken({ auth: 'session' })
      setAnonSettings(updated)
      setSavedAnonSettings(updated)
    } catch (error) {
      console.error('Failed to rotate anonymous chat token:', error)
    } finally {
      setIsAnonSaving(false)
    }
  }

  useEffect(() => {
    if (!humanContactSettings || !savedHumanContactSettings || !hasHumanContactChanges) {
      return
    }
    if (
      humanContactMissingDelivery ||
      humanContactMissingEmail ||
      humanContactMissingWebhook ||
      humanContactDefaultEmailInvalid ||
      humanContactWebhookUrlInvalid
    ) {
      return
    }

    const timeout = window.setTimeout(async () => {
      const draftVersionAtRequestStart = humanContactDraftVersionRef.current
      const saveId = saveSequenceRef.current + 1
      saveSequenceRef.current = saveId
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
        if (saveSequenceRef.current !== saveId) return
        setSavedHumanContactSettings(updated)
        setHumanContactSigningSecret('')
        if (humanContactDraftVersionRef.current === draftVersionAtRequestStart) {
          setHumanContactSettings(updated)
          setSaveState('saved')
        }
      } catch (error) {
        if (saveSequenceRef.current !== saveId) return
        console.error('Failed to update human contact settings:', error)
        const message = getApiErrorMessage(error, 'Failed to save human contact settings.')
        setHumanContactError(message)
        setSaveState('error')
        setSaveError(message)
      } finally {
        if (saveSequenceRef.current === saveId) {
          setIsHumanContactSaving(false)
        }
      }
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [
    hasHumanContactChanges,
    humanContactDefaultEmailInvalid,
    humanContactDefaultEmailTrimmed,
    humanContactEmailEnabled,
    humanContactMissingDelivery,
    humanContactMissingEmail,
    humanContactMissingWebhook,
    humanContactSettings,
    humanContactWebhookEnabled,
    humanContactWebhookUrl,
    humanContactWebhookUrlInvalid,
    humanContactWebhookUrlTrimmed,
    savedHumanContactSettings,
    saveSequenceRef,
    setSaveError,
    setSaveState,
  ])

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
      console.error('Failed to rotate contact handoff signing token:', error)
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
      console.error('Failed to reveal contact handoff signing token:', error)
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
                  disabled={isOrganizationLoading || !canManageOrganization}
                />
                {!canManageOrganization ? (
                  <p className="text-sm text-muted-foreground">Only owners and admins can rename the organization.</p>
                ) : null}
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
                    disabled={!activeWorkspaceId || isApiTokenLoading || !canReadWorkspaceTokens}
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
                    {canReadWorkspaceTokens
                      ? 'Reveal the token only when you need to copy it into another client.'
                      : 'Sign in to reveal workspace API tokens.'}
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
              <AssistantBehaviorSection
                anonSettings={anonSettings}
                assistantBehaviorSettings={assistantBehaviorSettings}
                assistantLocaleInput={assistantLocaleInput}
                onAssistantSettingChange={handleAssistantSettingChange}
                onAssistantLocaleInputChange={handleAssistantLocaleInputChange}
                onAssistantBehaviorDraft={updateAssistantBehaviorDraft}
                onAssistantLogoUpload={(file) => void handleAssistantLogoUpload(file)}
                onAssistantLogoDelete={() => void handleAssistantLogoDelete()}
                isAnonSaving={isAnonSaving}
                isAssistantLogoSaving={isAssistantLogoSaving}
                assistantSettingsError={assistantSettingsError}
                sourceList={sourceList}
                isSourceListLoading={isSourceListLoading}
                sourceListError={sourceListError}
                channelsTabHref={channelsTabHref}
                websiteEmbedAvailable={editionController.canUseWebsiteEmbed()}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load assistant settings.</p>
            )}
          </section>
          ) : null}

          {editionController.canUseHumanContact() && mode === 'assistant' ? (
          <section id="human-contact" className="space-y-6 scroll-mt-24">
            <section className="scroll-mt-24 rounded-2xl border border-border bg-card/95 p-5 shadow-sm">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
                    <UserRound className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-foreground">Contact handoff</h3>
                      {humanContactSettings?.enabled && humanContactSettings.configured && !hasHumanContactChanges ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" /> Ready
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Route follow-up requests through the configured delivery channel.
                    </p>
                  </div>
                </div>
                <Switch
                  id="humanContactToggle"
                  checked={humanContactSettings?.enabled ?? false}
                  onCheckedChange={(checked) => updateHumanContactSettingsDraft({ enabled: checked })}
                  disabled={isHumanContactLoading || isHumanContactSaving || !humanContactSettings}
                  className="sm:mt-3"
                />
              </div>

              {isHumanContactLoading ? (
                <div className="flex items-center justify-center py-8">
                  <LogoSpinner imageClassName="h-6 w-6" />
                </div>
              ) : humanContactSettings ? (
                humanContactSettings.enabled ? (
                  <div className="mt-5 space-y-4">
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
                              onCheckedChange={(checked) => updateHumanContactSettingsDraft({ emailEnabled: checked })}
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
                                onChange={(event) => updateHumanContactSettingsDraft({ defaultEmail: event.target.value })}
                                placeholder="support@example.com"
                                disabled={isHumanContactSaving}
                              />
                              {humanContactDefaultEmailInvalid ? (
                                <p className="text-xs text-destructive">Enter a valid email address.</p>
                              ) : humanContactMissingEmail ? (
                                <p className="text-xs text-destructive">Add a default email address.</p>
                              ) : (
                                <p className="text-xs text-muted-foreground">Requests are emailed here.</p>
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
                              onCheckedChange={(checked) => updateHumanContactSettingsDraft({ webhookEnabled: checked })}
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
                                  onChange={(event) => updateHumanContactSettingsDraft({ webhookUrl: event.target.value })}
                                  placeholder="https://support.example.com/radioso/contact-handoff"
                                  disabled={isHumanContactSaving}
                                />
                                {humanContactWebhookUrlInvalid ? (
                                  <p className="text-xs text-destructive">Enter a valid http(s) webhook URL.</p>
                                ) : humanContactMissingWebhook ? (
                                  <p className="text-xs text-destructive">Add a webhook URL.</p>
                                ) : (
                                  <p className="text-xs text-muted-foreground">Radioso sends each request to this endpoint.</p>
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
                                      : 'A signing token is generated automatically once webhook setup is saved.'}
                                  </p>
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    {humanContactMissingDelivery ? (
                      <p className="inline-flex items-center gap-1.5 text-sm text-destructive">
                        <CircleAlert className="h-4 w-4" />
                        Pick Email or Webhook so requests have somewhere to go.
                      </p>
                    ) : null}

                    {humanContactError ? (
                      <p className="text-sm text-destructive" role="alert">{humanContactError}</p>
                    ) : null}
                  </div>
                ) : null
              ) : (
                <div className="mt-5 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  Contact handoff is unavailable in this build.
                  {humanContactError ? (
                    <p className="mt-2 text-destructive" role="alert">{humanContactError}</p>
                  ) : null}
                </div>
              )}
            </section>
          </section>
          ) : null}

          {mode === 'channels' && isAnonLoading ? (
          <section className="flex min-h-[320px] items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading ? (
          <section id="public-chat-link" className="space-y-6 scroll-mt-24">
            {anonSettings ? (
              <section className="scroll-mt-24 rounded-2xl border border-border bg-card/95 p-5 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
                      <LinkIcon className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-medium text-foreground">Public chat link</h3>
                      <p className="text-sm text-muted-foreground">
                        A shareable URL anyone can open without signing in.
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
                  <div className="mt-5 space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                      <CopyValueField
                        value={anonSettings.anonymousChatUrl}
                        ariaLabel="Copy public chat link"
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
                    <div className="flex justify-end">
                      <Button variant="outline" onClick={handleAnonymousChatTokenRotate} disabled={isAnonSaving}>
                        {isAnonSaving ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                        Reset link
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load public chat link settings.</p>
            )}
          </section>
          ) : null}


          <WebsiteEmbedSettingsController
            mode={mode}
            anonSettings={anonSettings}
            savedAnonSettings={savedAnonSettings}
            setAnonSettings={setAnonSettings}
            setSavedAnonSettings={setSavedAnonSettings}
            isAnonSaving={isAnonSaving}
            setIsAnonSaving={setIsAnonSaving}
            updateGeneralSettings={updateGeneralSettings}
            rotateWebsiteEmbedToken={rotateWebsiteEmbedToken}
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
                  <Button
                    variant="destructive"
                    size="sm"
                    className="sm:self-start"
                    disabled={!canRotateWorkspaceTokens}
                  >
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
                      disabled={isRotatingApiToken || !canRotateWorkspaceTokens}
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
                    disabled={isLastWorkspace || !canManageWorkspaceLifecycle}
                    title={
                      !canManageWorkspaceLifecycle
                        ? 'Only owners and admins can delete workspaces'
                        : isLastWorkspace
                          ? 'Cannot delete the last workspace'
                          : undefined
                    }
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
                      disabled={!canManageWorkspaceLifecycle}
                    />
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={!deleteConfirmValid || isDeleting || !canManageWorkspaceLifecycle}
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
