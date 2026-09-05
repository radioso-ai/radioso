'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, ChevronLeft, FolderOpen, Globe, KeyRound, MessageCircle, ShieldAlert, Trash2, Wrench } from 'lucide-react'

import { ApiChannelCard } from '@/components/dashboard/settings/api-channel-card'
import { AssistantContextVariablesSection } from '@/components/dashboard/settings/assistant-context-variables-section'
import { AssistantDirectivesSection } from '@/components/dashboard/settings/assistant-directives-section'
import { AssistantProfileSection } from '@/components/dashboard/settings/assistant-profile-section'
import { AssistantRoutinesSection } from '@/components/dashboard/settings/assistant-routines-section'
import { ChatChannelSection } from '@/components/dashboard/settings/chat-channel-section'
import { ConnectorSetupDialog } from '@/components/dashboard/documents/connector-setup-dialog'
import { McpChannelCard } from '@/components/dashboard/settings/mcp-channel-card'
import { SlackChannelCard } from '@/components/dashboard/settings/slack-channel-card'
import { McpConnectionsSection } from '@/components/dashboard/settings/skills/McpConnectionsSection'
import { SkillList } from '@/components/dashboard/settings/skills/SkillList'
import { SettingsRow, SettingsRowList } from '@/components/dashboard/settings/settings-row-list'
import { type AgentSectionId } from '@/lib/dashboard-areas'
import { type DashboardRouteState } from '@/lib/dashboard-routes'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import {
  getAssistantLocaleLabel,
  NO_GREETING_LOCALE_LABEL,
  resolveAssistantLocaleInput,
} from '@/components/dashboard/settings/assistant-locale-options'
import { DEFAULT_ASSISTANT_THEME } from '@/components/dashboard/settings/assistant-theme-form-helpers'
import { AgentBundleExportCard } from '@/components/dashboard/settings/agent-bundle-export-card'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { useSettingsSaveStatus } from '@/components/dashboard/settings/use-settings-save-status'
import { WebhookDestinationsPanel } from '@/components/dashboard/settings/webhook-destinations-panel'
import { WorkspaceEmailConnectionsSection } from '@/components/dashboard/settings/workspace-email-connections-section'
import { Button } from '@/components/ui/button'
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

type ChannelId = 'web-chat' | 'api-channel' | 'mcp-channel' | 'slack-channel' | 'whatsapp-channel'

const CHANNEL_TITLES: Record<ChannelId, string> = {
  'web-chat': 'Web chat',
  'api-channel': 'Agent API',
  'mcp-channel': 'MCP channel',
  'slack-channel': 'Slack',
  'whatsapp-channel': 'WhatsApp',
}

const fallbackRetrievalDefaults: RetrievalDefaults = {
  queryRewriteEnabled: false,
  temporalStructuredLookupEnabled: true,
  temporalBoostUpcomingEnabled: true,
  temporalDeterministicSortEnabled: true,
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
  profileHref,
  onSaveStateChange,
}: {
  accountId: string
  mode: 'workspace' | 'assistant' | 'channels'
  agentId?: string
  /** When set, render only this section (the second column owns selection). */
  agentSection?: AgentSectionId
  routeState?: DashboardRouteState
  profileHref?: string
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
  const [agentInternalName, setAgentInternalName] = useState<string>('')
  const [agentCount, setAgentCount] = useState<number>(0)
  const [deleteAgentConfirmName, setDeleteAgentConfirmName] = useState('')
  const [isDeletingAgent, setIsDeletingAgent] = useState(false)
  const [deleteAgentDialogOpen, setDeleteAgentDialogOpen] = useState(false)
  const [deleteAgentError, setDeleteAgentError] = useState<string | null>(null)
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
  const [selectedChannel, setSelectedChannel] = useState<ChannelId | null>(null)
  const [whatsappSetupOpen, setWhatsappSetupOpen] = useState(false)
  // When the second column drives selection, render exactly one section and
  // skip the in-page channel index/back affordance.
  const showSection = (id: AgentSectionId) => !agentSection || agentSection === id
  const isChannelId = (id: AgentSectionId | undefined): id is ChannelId =>
    id === 'web-chat' || id === 'api-channel' || id === 'mcp-channel' || id === 'slack-channel' || id === 'whatsapp-channel'
  const resolvedChannel: ChannelId | null = isChannelId(agentSection) ? agentSection : selectedChannel
  const channelIndexEnabled = !agentSection
  const organizationDraftVersionRef = useRef(0)
  const workspaceDraftVersionRef = useRef(0)
  const anonDraftVersionRef = useRef(0)
  const assistantBehaviorDraftVersionRef = useRef(0)
  const canManageOrganization = currentAccountRole === 'owner' || currentAccountRole === 'admin'
  const canManageWorkspaceLifecycle = currentAccountRole === 'owner' || currentAccountRole === 'admin'
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

  const updateAssistantBehaviorSettings = useCallback(async (
    data: AssistantBehaviorSettings,
    saved: AssistantBehaviorSettings,
  ) => {
    if (!agentId) {
      throw new Error('Assistant behavior settings require an agent')
    }
    return agentsApi.updateBehaviorSettings(agentId, data, saved)
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
    if (mode !== 'assistant' && mode !== 'channels') {
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
  const operatorAgentName = getAgentOperatorLabel({ internalName: agentInternalName, name: agentName }, 'Agent')
  // Slack must use an empty label fallback so the workspace assistant name can still be used.
  const slackAgentName = getAgentOperatorLabel({ internalName: agentInternalName, name: agentName }, '') || anonSettings?.assistantName || ''
  const deleteAgentConfirmValid = deleteAgentConfirmName.trim() === operatorAgentName.trim()

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
          setAgentInternalName(current?.internalName ?? '')
        } else {
          setAgentName('')
          setAgentInternalName('')
        }
      } catch {
        if (!active) return
        setAgentCount(0)
        setAgentName('')
        setAgentInternalName('')
      }
    })()
    return () => {
      active = false
    }
  }, [agentId, mode, activeWorkspaceId])

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
          (anonSettings.internalName ?? '') !== (savedAnonSettings.internalName ?? '') ||
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
          assistantBehaviorSettings.handoffOnRetrievalMiss !== savedAssistantBehaviorSettings.handoffOnRetrievalMiss ||
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
          internalName: anonSettings.internalName,
          assistantDefaultLocale: anonSettings.assistantDefaultLocale,
          proactiveGreetingEnabled: anonSettings.proactiveGreetingEnabled,
        })
        if (saveSequenceRef.current !== saveId) return
        const nameChanged = savedAnonSettings.assistantName !== updated.assistantName
        const internalNameChanged = (savedAnonSettings.internalName ?? '') !== (updated.internalName ?? '')
        setSavedAnonSettings(updated)
        setAssistantSettingsError(null)
        // Both feed the agent switcher's label; either change should refresh it.
        if (nameChanged || internalNameChanged) {
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
          await updateAssistantBehaviorSettings(assistantBehaviorSettings, savedAssistantBehaviorSettings),
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

            <WebhookDestinationsPanel onSaveStateChange={onSaveStateChange} />

        </section>
        ) : null}

          {mode === 'assistant' && showSection('profile') ? (
          <section id="assistant-profile" className="space-y-6 scroll-mt-24">
            {isAnonLoading || isAssistantBehaviorLoading ? (
              <div className="flex items-center justify-center py-4">
                <LogoSpinner imageClassName="h-6 w-6" />
              </div>
            ) : anonSettings && assistantBehaviorSettings ? (
              <div className="space-y-6">
                {assistantSettingsError ? (
                  <p className="text-sm text-destructive" role="alert">{assistantSettingsError}</p>
                ) : null}
                <AssistantProfileSection
                  anonSettings={anonSettings}
                  assistantBehaviorSettings={assistantBehaviorSettings}
                  assistantLocaleInput={assistantLocaleInput}
                  showInternalName={Boolean(agentId)}
                  onAssistantSettingChange={handleAssistantSettingChange}
                  onAssistantLocaleInputChange={handleAssistantLocaleInputChange}
                  onAssistantBehaviorDraft={updateAssistantBehaviorDraft}
                  isAnonSaving={isAnonSaving}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Failed to load assistant settings.</p>
            )}
            {agentId ? (
              <AgentBundleExportCard agentId={agentId} agentName={operatorAgentName} />
            ) : null}
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
                icon={<Globe className="h-5 w-5 text-primary" />}
                title={CHANNEL_TITLES['web-chat']}
                description="A shareable link and a website widget, sharing one look and wording."
                status={
                  anonSettings?.anonymousChatEnabled || anonSettings?.websiteEmbedEnabled
                    ? { label: 'On', tone: 'active' }
                    : { label: 'Off', tone: 'muted' }
                }
                onClick={() => setSelectedChannel('web-chat')}
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

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'web-chat' ? (
            <ChatChannelSection
              mode={mode}
              anonSettings={anonSettings}
              savedAnonSettings={savedAnonSettings}
              setAnonSettings={setAnonSettings}
              setSavedAnonSettings={setSavedAnonSettings}
              assistantBehaviorSettings={assistantBehaviorSettings}
              retrievalDefaults={effectiveRetrievalDefaults}
              onAssistantBehaviorDraft={updateAssistantBehaviorDraft}
              onAssistantLogoUpload={(file) => void handleAssistantLogoUpload(file)}
              onAssistantLogoDelete={() => void handleAssistantLogoDelete()}
              onAnonymousChatToggle={(enabled) => void handleAnonToggle(enabled)}
              onAnonymousChatTokenRotate={() => void handleAnonymousChatTokenRotate()}
              isAnonSaving={isAnonSaving}
              setIsAnonSaving={setIsAnonSaving}
              isAssistantLogoSaving={isAssistantLogoSaving}
              updateGeneralSettings={updateGeneralSettings}
              rotateWebsiteEmbedToken={rotateWebsiteEmbedToken}
              anonDraftVersionRef={anonDraftVersionRef}
              saveSequenceRef={saveSequenceRef}
              setSaveState={setSaveState}
              setSaveError={setSaveError}
              profileHref={profileHref}
            />
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'api-channel' ? (
          <section id="api-channel" className="space-y-6 scroll-mt-24">
            {agentId ? <ApiChannelCard agentId={agentId} /> : null}
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'mcp-channel' ? (
          <section id="mcp-channel" className="space-y-6 scroll-mt-24">
            {agentId ? <McpChannelCard agentId={agentId} /> : null}
            {agentId ? <McpConnectionsSection agentId={agentId} /> : null}
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'slack-channel' ? (
          <section id="slack-channel" className="space-y-6 scroll-mt-24">
            <SlackChannelCard
              workspaceId={activeWorkspaceId}
              agentId={agentId}
              agentName={slackAgentName}
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
                        This will permanently delete the agent <strong>{operatorAgentName}</strong> and
                        its channel tokens, conversations, and settings. This action cannot be undone.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2 py-2">
                      <Label htmlFor="deleteAgentConfirm" className="text-foreground">
                        Type <strong>{operatorAgentName}</strong> to confirm
                      </Label>
                      <Input
                        id="deleteAgentConfirm"
                        value={deleteAgentConfirmName}
                        onChange={(event) => setDeleteAgentConfirmName(event.target.value)}
                        placeholder={operatorAgentName}
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
