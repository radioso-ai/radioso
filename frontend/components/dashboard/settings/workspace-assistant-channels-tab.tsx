'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, ChevronLeft, ExternalLink, FolderOpen, Globe, KeyRound, Link as LinkIcon, MessageCircle, RefreshCw, ShieldAlert, Trash2, Wrench } from 'lucide-react'

import { ApiChannelCard } from '@/components/dashboard/settings/api-channel-card'
import { AssistantBehaviorSection } from '@/components/dashboard/settings/assistant-behavior-section'
import { AssistantContextVariablesSection } from '@/components/dashboard/settings/assistant-context-variables-section'
import { AssistantDirectivesSection } from '@/components/dashboard/settings/assistant-directives-section'
import { AssistantIdentityAppearanceSection } from '@/components/dashboard/settings/assistant-identity-appearance-section'
import { AssistantPreviewRail } from '@/components/dashboard/settings/assistant-preview-rail'
import { AssistantRoutinesSection } from '@/components/dashboard/settings/assistant-routines-section'
import { ConnectorSetupDialog } from '@/components/dashboard/documents/connector-setup-dialog'
import { McpChannelCard } from '@/components/dashboard/settings/mcp-channel-card'
import { SlackChannelCard } from '@/components/dashboard/settings/slack-channel-card'
import { McpConnectionsSection } from '@/components/dashboard/settings/skills/McpConnectionsSection'
import { SkillList } from '@/components/dashboard/settings/skills/SkillList'
import { SettingsRow, SettingsRowList } from '@/components/dashboard/settings/settings-row-list'
import { type AgentSectionId } from '@/lib/dashboard-areas'
import { type DashboardRouteState } from '@/lib/dashboard-routes'
import {
  getAssistantLocaleLabel,
  NO_GREETING_LOCALE_LABEL,
  resolveAssistantLocaleInput,
} from '@/components/dashboard/settings/assistant-locale-options'
import { DEFAULT_ASSISTANT_THEME } from '@/components/dashboard/settings/assistant-theme-form-helpers'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { WebhookDestinationsPanel } from '@/components/dashboard/settings/webhook-destinations-panel'
import { WebsiteEmbedSettingsController } from '@/components/dashboard/settings/website-embed-settings-controller'
import { WorkspaceEmailConnectionsSection } from '@/components/dashboard/settings/workspace-email-connections-section'
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
import { storeAccountOrganizationName } from '@/lib/auth-context'
import {
  accountApi,
  agentsApi,
  generalSettingsApi,
  settingsApi,
  type AssistantBehaviorSettings,
  type AccountMembershipRole,
  type GeneralSettings,
  type RetrievalDefaults,
} from '@/lib/api'
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

type GeneralSettingsUpdateInput = Parameters<typeof generalSettingsApi.updateGeneralSettings>[0]

type ChannelId = 'public-chat-link' | 'website-embed' | 'api-channel' | 'mcp-channel' | 'slack-channel' | 'whatsapp-channel'

const CHANNEL_TITLES: Record<ChannelId, string> = {
  'public-chat-link': 'Public chat link',
  'website-embed': 'Website chat widget',
  'api-channel': 'API channel',
  'mcp-channel': 'MCP channel',
  'slack-channel': 'Slack',
  'whatsapp-channel': 'WhatsApp',
}

const formatLastUsed = (value: string | null | undefined) => {
  if (!value) {
    return 'Never used'
  }
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) {
    return 'Last used: Unknown'
  }
  const diffSeconds = Math.round((timestamp - Date.now()) / 1000)
  const absoluteSeconds = Math.abs(diffSeconds)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, unitSeconds] of units) {
    if (absoluteSeconds >= unitSeconds) {
      return `Last used: ${formatter.format(Math.round(diffSeconds / unitSeconds), unit)}`
    }
  }
  return `Last used: ${formatter.format(diffSeconds, 'second')}`
}

const fallbackRetrievalDefaults: RetrievalDefaults = {
  queryRewriteEnabled: false,
  semanticRewriteInstructions: '',
  lexicalRewriteInstructions: '',
  suggestedQuestionsEnabled: true,
  suggestedQuestionsCount: 3,
  rerankEnabled: false,
  vectorTopK: 15,
  rerankTopK: 5,
  retrievalStrategy: 'fixed',
  metadataRules: [],
  metadataFieldSuggestions: [],
  customInstruction: '',
}

const normalizeAssistantBehaviorSettingsByAgent = (agentId: string | undefined, settings: AssistantBehaviorSettings) => ({
  ...settings,
  sourceScope: agentId ? settings.sourceScope ?? { mode: 'all' } : undefined,
})

export function WorkspaceAssistantChannelsTab({
  accountId,
  mode,
  agentId,
  agentSection,
  routeState,
  channelsTabHref,
  onSaveStateChange,
}: {
  accountId: string
  mode: 'workspace' | 'assistant' | 'channels'
  agentId?: string
  /** When set, render only this section (the second column owns selection). */
  agentSection?: AgentSectionId
  routeState?: DashboardRouteState
  channelsTabHref?: string
  onSaveStateChange?: (input: { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }) => void
}) {
  const router = useRouter()
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
  const [deleteOrgConfirmName, setDeleteOrgConfirmName] = useState('')
  const [isDeletingOrg, setIsDeletingOrg] = useState(false)
  const [deleteOrgDialogOpen, setDeleteOrgDialogOpen] = useState(false)
  const [deleteOrgError, setDeleteOrgError] = useState<string | null>(null)
  const [agentName, setAgentName] = useState<string>('')
  const [agentCount, setAgentCount] = useState<number>(0)
  const [deleteAgentConfirmName, setDeleteAgentConfirmName] = useState('')
  const [isDeletingAgent, setIsDeletingAgent] = useState(false)
  const [deleteAgentDialogOpen, setDeleteAgentDialogOpen] = useState(false)
  const [deleteAgentError, setDeleteAgentError] = useState<string | null>(null)
  const [rotateApiTokenDialogOpen, setRotateApiTokenDialogOpen] = useState(false)
  const [isRotatingApiToken, setIsRotatingApiToken] = useState(false)
  const [rotateApiTokenError, setRotateApiTokenError] = useState<string | null>(null)
  const isLastWorkspace = workspaces.length <= 1
  const deleteConfirmValid = deleteConfirmName === activeWorkspace?.name
  const [anonSettings, setAnonSettings] = useState<GeneralSettings | null>(null)
  const [savedAnonSettings, setSavedAnonSettings] = useState<GeneralSettings | null>(null)
  const [isAnonLoading, setIsAnonLoading] = useState(true)
  const [isAnonSaving, setIsAnonSaving] = useState(false)
  const [assistantBehaviorSettings, setAssistantBehaviorSettings] = useState<AssistantBehaviorSettings | null>(null)
  const [savedAssistantBehaviorSettings, setSavedAssistantBehaviorSettings] = useState<AssistantBehaviorSettings | null>(null)
  const [retrievalDefaults, setRetrievalDefaults] = useState<RetrievalDefaults | null>(null)
  const [isAssistantBehaviorLoading, setIsAssistantBehaviorLoading] = useState(mode === 'assistant')
  const [isAssistantLogoSaving, setIsAssistantLogoSaving] = useState(false)
  const { setSaveState, setSaveError, saveSequenceRef } = useSettingsSaveStatus(onSaveStateChange)
  const [assistantSettingsError, setAssistantSettingsError] = useState<string | null>(null)
  const [assistantLocaleInput, setAssistantLocaleInput] = useState(NO_GREETING_LOCALE_LABEL)
  const [apiToken, setApiToken] = useState<string | null>(null)
  const [apiTokenError, setApiTokenError] = useState<string | null>(null)
  const [isApiTokenLoading, setIsApiTokenLoading] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState<ChannelId | null>(null)
  const [whatsappSetupOpen, setWhatsappSetupOpen] = useState(false)
  // When the second column drives selection, render exactly one section and
  // skip the in-page channel index/back affordance.
  const showSection = (id: AgentSectionId) => !agentSection || agentSection === id
  const isChannelId = (id: AgentSectionId | undefined): id is ChannelId =>
    id === 'public-chat-link' || id === 'website-embed' || id === 'api-channel' || id === 'mcp-channel' || id === 'slack-channel' || id === 'whatsapp-channel'
  const resolvedChannel: ChannelId | null = isChannelId(agentSection) ? agentSection : selectedChannel
  const channelIndexEnabled = !agentSection
  const organizationDraftVersionRef = useRef(0)
  const workspaceDraftVersionRef = useRef(0)
  const anonDraftVersionRef = useRef(0)
  const assistantBehaviorDraftVersionRef = useRef(0)
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

  // Assistant behavior settings are per-agent only; this tab loads/saves them solely in
  // `mode === 'assistant'` (which always carries an agentId). Workspace mode renders channels
  // and general settings, not retrieval/answer behavior.
  const loadAssistantBehaviorSettings = useCallback(async () => {
    if (!agentId) {
      throw new Error('Assistant behavior settings require an agent')
    }
    return agentsApi.getBehaviorSettings(agentId)
  }, [agentId])

  const updateAssistantBehaviorSettings = useCallback(async (data: AssistantBehaviorSettings) => {
    if (!agentId) {
      throw new Error('Assistant behavior settings require an agent')
    }
    return agentsApi.updateBehaviorSettings(agentId, data)
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Switching agent/workspace returns the channels list to its index.
    setSelectedChannel(null)
  }, [agentId, activeWorkspaceId])

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
      setRetrievalDefaults(null)
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
    const loadRetrievalDefaults = async () => {
      try {
        const defaults = await settingsApi.getRetrievalDefaults({ auth: 'session' })
        if (!active) return
        setRetrievalDefaults(defaults)
      } catch (error) {
        if (!active) return
        console.error('Failed to load retrieval defaults:', error)
        setRetrievalDefaults(null)
      }
    }

    void loadAssistantBehaviorSettingsEffect()
    void loadRetrievalDefaults()
    return () => {
      active = false
    }
  }, [activeWorkspaceId, agentId, isWorkspaceLoading, loadAssistantBehaviorSettings, mode])

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

  const canDeleteOrganization = currentAccountRole === 'owner'
  const deleteOrgConfirmValid = deleteOrgConfirmName.trim() === savedOrganizationName.trim() && savedOrganizationName.trim().length > 0

  const handleDeleteOrganization = async () => {
    if (!canDeleteOrganization || !deleteOrgConfirmValid) return
    setIsDeletingOrg(true)
    setDeleteOrgError(null)
    try {
      await accountApi.deleteOrganization()
      setDeleteOrgDialogOpen(false)
      setDeleteOrgConfirmName('')
      if (typeof window !== 'undefined') {
        window.location.href = '/login'
      }
    } catch (error) {
      setDeleteOrgError(getApiErrorMessage(error, 'Failed to delete the organization.'))
      setIsDeletingOrg(false)
    }
  }

  const canDeleteAgent = currentAccountRole === 'owner' || currentAccountRole === 'admin'
  const isLastAgent = agentCount <= 1
  const deleteAgentConfirmValid = agentName.trim().length > 0 && deleteAgentConfirmName.trim() === agentName.trim()

  const handleDeleteAgent = async () => {
    if (!agentId || !canDeleteAgent || !deleteAgentConfirmValid || isLastAgent) return
    setIsDeletingAgent(true)
    setDeleteAgentError(null)
    try {
      await agentsApi.deleteAgent(agentId)
      setDeleteAgentDialogOpen(false)
      setDeleteAgentConfirmName('')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('radioso:agents-updated'))
      }
      router.push(`/account/${accountId}/agents`)
    } catch (error) {
      setDeleteAgentError(getApiErrorMessage(error, 'Failed to delete the agent.'))
      setIsDeletingAgent(false)
    }
  }

  useEffect(() => {
    if (mode !== 'assistant') {
      return
    }

    let active = true
    void (async () => {
      try {
        const response = await agentsApi.listAgents()
        if (!active) return
        setAgentCount(response.agents.length)
        if (agentId) {
          const current = response.agents.find((agent) => agent.id === agentId)
          setAgentName(current?.name ?? '')
        } else {
          setAgentName('')
        }
      } catch {
        if (!active) return
        setAgentCount(0)
        setAgentName('')
      }
    })()
    return () => {
      active = false
    }
  }, [agentId, mode, activeWorkspaceId])

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
    return `curl ${origin}${apiBasePath}/settings/retrieval-defaults \\\n  -H "Authorization: Bearer <token>"`
  }, [])
  const effectiveRetrievalDefaults = retrievalDefaults ?? fallbackRetrievalDefaults

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
          assistantBehaviorSettings.assistantLinkUtmEnabled !== savedAssistantBehaviorSettings.assistantLinkUtmEnabled ||
          assistantBehaviorSettings.citationDisplayEnabled !== savedAssistantBehaviorSettings.citationDisplayEnabled ||
          JSON.stringify(assistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME) !==
            JSON.stringify(savedAssistantBehaviorSettings.theme ?? DEFAULT_ASSISTANT_THEME) ||
          JSON.stringify(assistantBehaviorSettings.branding ?? null) !==
            JSON.stringify(savedAssistantBehaviorSettings.branding ?? null)
        )
      : false

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
        storeAccountOrganizationName(window.localStorage, accountId, updated.organizationName)
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
  }, [
    agentId,
    assistantBehaviorSettings,
    hasAssistantBehaviorChanges,
    saveSequenceRef,
    savedAssistantBehaviorSettings,
    setSaveError,
    setSaveState,
    updateAssistantBehaviorSettings,
  ])

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

            <WebhookDestinationsPanel onSaveStateChange={onSaveStateChange} />

        </section>
        ) : null}

          {mode === 'assistant' && (showSection('identity') || showSection('behavior')) ? (
          <section id={showSection('behavior') ? 'assistant-behavior' : 'assistant-identity'} className="space-y-6 scroll-mt-24">
            {isAnonLoading || isAssistantBehaviorLoading ? (
              <div className="flex items-center justify-center py-4">
                <LogoSpinner imageClassName="h-6 w-6" />
              </div>
            ) : anonSettings && assistantBehaviorSettings ? (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
                <div className="space-y-6">
                  {assistantSettingsError ? (
                    <p className="text-sm text-destructive" role="alert">{assistantSettingsError}</p>
                  ) : null}
                  {showSection('identity') ? (
                    <AssistantIdentityAppearanceSection
                      anonSettings={anonSettings}
                      assistantBehaviorSettings={assistantBehaviorSettings}
                      onAssistantSettingChange={handleAssistantSettingChange}
                      onAssistantBehaviorDraft={updateAssistantBehaviorDraft}
                      onAssistantLogoUpload={(file) => void handleAssistantLogoUpload(file)}
                      onAssistantLogoDelete={() => void handleAssistantLogoDelete()}
                      isAnonSaving={isAnonSaving}
                      isAssistantLogoSaving={isAssistantLogoSaving}
                    />
                  ) : null}
                  {showSection('behavior') ? (
                    <AssistantBehaviorSection
                      anonSettings={anonSettings}
                      assistantBehaviorSettings={assistantBehaviorSettings}
                      assistantLocaleInput={assistantLocaleInput}
                      onAssistantSettingChange={handleAssistantSettingChange}
                      onAssistantLocaleInputChange={handleAssistantLocaleInputChange}
                      onAssistantBehaviorDraft={updateAssistantBehaviorDraft}
                      isAnonSaving={isAnonSaving}
                    />
                  ) : null}
                </div>
                <AssistantPreviewRail
                  anonSettings={anonSettings}
                  assistantBehaviorSettings={assistantBehaviorSettings}
                  retrievalDefaults={effectiveRetrievalDefaults}
                  channelsTabHref={channelsTabHref}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load assistant settings.</p>
            )}
          </section>
          ) : null}

          {mode === 'assistant' && showSection('skills') ? (
          <section id="assistant-skills" className="space-y-6 scroll-mt-24">
            {agentId ? <SkillList agentId={agentId} /> : null}
          </section>
          ) : null}

          {mode === 'assistant' && agentId && showSection('context-variables') ? (
          <section id="assistant-context-variables" className="space-y-6 scroll-mt-24">
            <AssistantContextVariablesSection agentId={agentId} onSaveStateChange={onSaveStateChange} />
          </section>
          ) : null}

          {mode === 'assistant' && agentId && showSection('directives') ? (
          <section id="assistant-directives" className="space-y-6 scroll-mt-24">
            <AssistantDirectivesSection agentId={agentId} onSaveStateChange={onSaveStateChange} />
          </section>
          ) : null}

          {mode === 'assistant' && agentId && showSection('routines') ? (
          <section id="assistant-routines" className="space-y-6 scroll-mt-24">
            <AssistantRoutinesSection
              accountId={accountId}
              agentId={agentId}
              routeState={routeState}
              onSaveStateChange={onSaveStateChange}
            />
          </section>
          ) : null}

          {mode === 'channels' && isAnonLoading ? (
          <section className="flex min-h-[320px] items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading && channelIndexEnabled && selectedChannel === null ? (
          <section className="space-y-4">
            <SettingsRowList>
              <SettingsRow
                icon={<LinkIcon className="h-5 w-5 text-primary" />}
                title={CHANNEL_TITLES['public-chat-link']}
                description="A shareable URL anyone can open without signing in."
                status={anonSettings?.anonymousChatEnabled ? { label: 'On', tone: 'active' } : { label: 'Off', tone: 'muted' }}
                onClick={() => setSelectedChannel('public-chat-link')}
              />
              <SettingsRow
                icon={<Globe className="h-5 w-5 text-primary" />}
                title={CHANNEL_TITLES['website-embed']}
                description="Add a chat button to your website so visitors can ask questions."
                status={anonSettings?.websiteEmbedEnabled ? { label: 'On', tone: 'active' } : { label: 'Off', tone: 'muted' }}
                onClick={() => setSelectedChannel('website-embed')}
              />
              <SettingsRow
                icon={<KeyRound className="h-5 w-5 text-primary" />}
                title={CHANNEL_TITLES['api-channel']}
                description="Programmatic access for SDK clients and integrations."
                onClick={() => setSelectedChannel('api-channel')}
              />
              <SettingsRow
                icon={<Wrench className="h-5 w-5 text-primary" />}
                title={CHANNEL_TITLES['mcp-channel']}
                description="Connect Model Context Protocol clients to this agent."
                onClick={() => setSelectedChannel('mcp-channel')}
              />
              <SettingsRow
                icon={<MessageCircle className="h-5 w-5 text-primary" />}
                title={CHANNEL_TITLES['slack-channel']}
                description="Reply to Slack DMs with this agent."
                onClick={() => setSelectedChannel('slack-channel')}
              />
              <SettingsRow
                icon={<MessageCircle className="h-5 w-5 text-primary" />}
                title={CHANNEL_TITLES['whatsapp-channel']}
                description="Reply to WhatsApp Business messages with this agent."
                onClick={() => setSelectedChannel('whatsapp-channel')}
              />
            </SettingsRowList>
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading && channelIndexEnabled && selectedChannel !== null ? (
          <button
            type="button"
            onClick={() => setSelectedChannel(null)}
            className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            All channels
          </button>
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'public-chat-link' ? (
          <section id="public-chat-link" className="space-y-6 scroll-mt-24">
            {anonSettings ? (
              <SettingsCard
                icon={<LinkIcon className="h-5 w-5 text-primary" />}
                title="Public chat link"
                description="A shareable URL anyone can open without signing in."
                headerEnd={
                  <Switch
                    id="anonChatToggle"
                    checked={anonSettings.anonymousChatEnabled}
                    onCheckedChange={handleAnonToggle}
                    disabled={isAnonSaving}
                  />
                }
              >
                <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {formatLastUsed(anonSettings.anonymousChatLastUsedAt)}
                  </span>
                </div>
                {anonSettings.anonymousChatEnabled && anonSettings.anonymousChatUrl ? (
                  <div className="space-y-3 rounded-xl bg-muted/50 p-4">
                    <div className="flex items-center gap-2 text-foreground">
                      <LinkIcon className="h-4 w-4" />
                      <Label className="text-foreground">Share this link</Label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Send this URL to anyone who needs the chat. They can open it without signing in.
                    </p>
                    <CopyValueField
                      value={anonSettings.anonymousChatUrl}
                      ariaLabel="Copy public chat link"
                      className="w-full"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleAnonymousChatTokenRotate}
                        disabled={isAnonSaving}
                        className="text-muted-foreground hover:text-foreground"
                        title="Generates a new public chat URL. The current link will stop working."
                      >
                        {isAnonSaving ? <Spinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                        Generate new link
                      </Button>
                      <Button asChild variant="default">
                        <a href={anonSettings.anonymousChatUrl} target="_blank" rel="noreferrer">
                          <ExternalLink className="mr-2 h-4 w-4" />
                          Try the chat
                        </a>
                      </Button>
                    </div>
                  </div>
                ) : null}
              </SettingsCard>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load public chat link settings.</p>
            )}
          </section>
          ) : null}


          {mode !== 'channels' || (!isAnonLoading && resolvedChannel === 'website-embed') ? (
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
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'api-channel' ? (
          <section id="api-channel" className="space-y-6 scroll-mt-24">
            <ApiChannelCard workspaceId={activeWorkspaceId} />
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'mcp-channel' ? (
          <section id="mcp-channel" className="space-y-6 scroll-mt-24">
            <McpChannelCard workspaceId={activeWorkspaceId} />
            {agentId ? <McpConnectionsSection agentId={agentId} /> : null}
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'slack-channel' ? (
          <section id="slack-channel" className="space-y-6 scroll-mt-24">
            <SlackChannelCard
              workspaceId={activeWorkspaceId}
              agentId={agentId}
              agentName={agentName || anonSettings?.assistantName || ''}
            />
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'whatsapp-channel' ? (
          <section id="whatsapp-channel" className="space-y-6 scroll-mt-24">
            <SettingsCard
              icon={<MessageCircle className="h-5 w-5 text-primary" />}
              title="WhatsApp"
              description="Connect a WhatsApp Business phone number so inbound messages can be answered by this agent."
              headerEnd={
                <Button type="button" onClick={() => setWhatsappSetupOpen(true)}>
                  Configure WhatsApp
                </Button>
              }
            >
              <p className="text-sm text-muted-foreground">
                Configure the Meta phone number ID, access token, app secret, and webhook verification token from the connector setup.
              </p>
            </SettingsCard>
            <ConnectorSetupDialog
              open={whatsappSetupOpen}
              connectorId="whatsapp"
              onOpenChange={setWhatsappSetupOpen}
            />
          </section>
          ) : null}

          {mode === 'workspace' ? (
          <section className="space-y-6">
            <WorkspaceEmailConnectionsSection workspaceId={activeWorkspaceId} />
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
            <div className="divide-y divide-border">
            <div className="flex flex-col gap-4 py-4 first:pt-0 sm:flex-row sm:items-start sm:justify-between">
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
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive sm:self-start"
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

            <div className="flex flex-col gap-4 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Delete this workspace</p>
                <p className="text-sm text-muted-foreground">
                  Permanently delete this workspace and all its documents, chats, and settings. This action cannot be undone.
                </p>
                {isLastWorkspace ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    You cannot delete your only workspace. Create another workspace first.
                  </p>
                ) : null}
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
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive sm:self-start"
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
                    Delete workspace
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

            <div className="flex flex-col gap-4 py-4 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">Delete this organization</p>
                <p className="text-sm text-muted-foreground">
                  Permanently delete the organization, all workspaces, agents, documents, and members. This action cannot be undone.
                </p>
                {!canDeleteOrganization ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Only the organization owner can delete the organization.
                  </p>
                ) : null}
              </div>

              <Dialog
                open={deleteOrgDialogOpen}
                onOpenChange={(open) => {
                  setDeleteOrgDialogOpen(open)
                  if (!open) {
                    setDeleteOrgConfirmName('')
                    setIsDeletingOrg(false)
                    setDeleteOrgError(null)
                  }
                }}
              >
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive sm:self-start"
                    disabled={!canDeleteOrganization}
                    title={!canDeleteOrganization ? 'Only the organization owner can delete the organization' : undefined}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete organization
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete organization</DialogTitle>
                    <DialogDescription>
                      This will permanently delete the organization <strong>{savedOrganizationName}</strong>,
                      including every workspace, agent, document, and member. This action cannot be undone.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2 py-2">
                    <Label htmlFor="deleteOrgConfirm" className="text-foreground">
                      Type <strong>{savedOrganizationName}</strong> to confirm
                    </Label>
                    <Input
                      id="deleteOrgConfirm"
                      value={deleteOrgConfirmName}
                      onChange={(event) => setDeleteOrgConfirmName(event.target.value)}
                      placeholder={savedOrganizationName}
                      disabled={!canDeleteOrganization}
                    />
                  </div>
                  {deleteOrgError ? <p className="text-sm text-destructive">{deleteOrgError}</p> : null}
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setDeleteOrgDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={handleDeleteOrganization}
                      disabled={!deleteOrgConfirmValid || isDeletingOrg || !canDeleteOrganization}
                    >
                      {isDeletingOrg ? <Spinner className="mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
                      Delete organization
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
            </div>
            </SettingsCard>
          </section>
          ) : null}

          {mode === 'assistant' && agentId && showSection('danger') ? (
          <section id="agent-danger-zone" className="space-y-6 scroll-mt-24">
            <SettingsCard
              icon={<ShieldAlert className="h-5 w-5 text-destructive" />}
              iconClassName="border-destructive/20 bg-destructive/10"
              className="border-destructive/50"
              title="Danger zone"
              description="Permanent agent actions that cannot be undone."
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Delete this agent</p>
                  <p className="text-sm text-muted-foreground">
                    Permanently delete this agent and its channel tokens, conversations, and settings. This action cannot be undone.
                  </p>
                  {isLastAgent ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      You cannot delete your only agent in this workspace. Create another agent first.
                    </p>
                  ) : !canDeleteAgent ? (
                    <p className="mt-2 text-sm text-muted-foreground">
                      Only owners and admins can delete agents.
                    </p>
                  ) : null}
                </div>

                <Dialog
                  open={deleteAgentDialogOpen}
                  onOpenChange={(open) => {
                    setDeleteAgentDialogOpen(open)
                    if (!open) {
                      setDeleteAgentConfirmName('')
                      setIsDeletingAgent(false)
                      setDeleteAgentError(null)
                    }
                  }}
                >
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive sm:self-start"
                      disabled={!canDeleteAgent || isLastAgent}
                      title={
                        !canDeleteAgent
                          ? 'Only owners and admins can delete agents'
                          : isLastAgent
                            ? 'Cannot delete the last agent in this workspace'
                            : undefined
                      }
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete agent
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Delete agent</DialogTitle>
                      <DialogDescription>
                        This will permanently delete the agent <strong>{agentName || 'this agent'}</strong> and
                        its channel tokens, conversations, and settings. This action cannot be undone.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2 py-2">
                      <Label htmlFor="deleteAgentConfirm" className="text-foreground">
                        Type <strong>{agentName || 'agent name'}</strong> to confirm
                      </Label>
                      <Input
                        id="deleteAgentConfirm"
                        value={deleteAgentConfirmName}
                        onChange={(event) => setDeleteAgentConfirmName(event.target.value)}
                        placeholder={agentName}
                        disabled={!canDeleteAgent || isLastAgent}
                      />
                    </div>
                    {deleteAgentError ? <p className="text-sm text-destructive">{deleteAgentError}</p> : null}
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setDeleteAgentDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={handleDeleteAgent}
                        disabled={!deleteAgentConfirmValid || isDeletingAgent || !canDeleteAgent || isLastAgent}
                      >
                        {isDeletingAgent ? <Spinner className="mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
                        Delete agent
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </SettingsCard>
          </section>
          ) : null}

      </div>
    </SettingsTabShell>
  )
}
