'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Building2, FolderOpen, MessageCircle, ShieldAlert, Trash2, Users } from 'lucide-react'

import { ApiChannelCard } from '@/components/dashboard/settings/api-channel-card'
import { AssistantContextVariablesSection } from '@/components/dashboard/settings/assistant-context-variables-section'
import { AssistantDirectivesSection } from '@/components/dashboard/settings/assistant-directives-section'
import { AssistantProfileSection } from '@/components/dashboard/settings/assistant-profile-section'
import { AssistantRoutinesSection } from '@/components/dashboard/settings/assistant-routines-section'
import { ChatChannelSection } from '@/components/dashboard/settings/chat-channel-section'
import { ConnectorSetupDialog } from '@/components/dashboard/documents/connector-setup-dialog'
import { ConversationRetentionCard } from '@/components/dashboard/settings/conversation-retention-card'
import { TimeZoneCard } from '@/components/dashboard/settings/time-zone-card'
import { EmailChannelCard } from '@/components/dashboard/settings/email-channel-card'
import { McpChannelCard } from '@/components/dashboard/settings/mcp-channel-card'
import { SlackChannelCard } from '@/components/dashboard/settings/slack-channel-card'
import { VoiceChannelCard } from '@/components/dashboard/settings/voice-channel-card'
import { SkillList } from '@/components/dashboard/settings/skills/SkillList'
import { AgentChannelsOverview } from '@/components/dashboard/agent-channels-overview'
import { type AgentSectionId, agentSectionRoute } from '@/lib/dashboard-areas'
import { buildAgentSectionHref, buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { useAgentChannels } from '@/lib/agent-channels-context'
import { useAgentById, useAgents } from '@/lib/agents-context'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import { mergeGeneralSettingsSnapshot } from '@/lib/general-settings-snapshot'
import {
  getAssistantLocaleLabel,
  NO_GREETING_LOCALE_LABEL,
  resolveAssistantLocaleInput,
} from '@/components/dashboard/settings/assistant-locale-options'
import { AgentBundleExportCard } from '@/components/dashboard/settings/agent-bundle-export-card'
import { SettingsCard } from '@/components/dashboard/settings/settings-card'
import { SettingsTabShell } from '@/components/dashboard/settings/settings-tab-shell'
import { useAgentDraftSaver } from '@/components/dashboard/settings/use-agent-draft-saver'
import { useAgentDraftWriter } from '@/components/dashboard/settings/use-agent-draft-writer'
import { useGreetingDraft } from '@/components/dashboard/settings/use-greeting-draft'
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
import { LogoSpinner } from '@/components/ui/spinner'
import { getApiErrorMessage } from '@/lib/api-error'
import { storeAccountOrganizationName, useAuth } from '@/lib/auth-context'
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
import { AGENT_DRAFT_SAVED_EVENT } from '@/lib/agent-draft-save-port'
import { readCachedOrganizationName, writeCachedOrganizationName } from '@/lib/organization-name-cache'

type GeneralSettingsUpdateInput = Parameters<typeof generalSettingsApi.updateGeneralSettings>[0]

type ChannelId = 'web-chat' | 'api-channel' | 'mcp-channel' | 'slack-channel' | 'whatsapp-channel' | 'email-channel'

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
  citationHoldEnabled: true,
}

const normalizeAssistantBehaviorSettingsByAgent = (agentId: string | undefined, settings: AssistantBehaviorSettings) => ({
  ...settings,
  sourceScope: agentId ? settings.sourceScope ?? { mode: 'all' } : undefined,
})

const liveAssistantBehaviorSettings = (settings: AssistantBehaviorSettings) => {
  const { customInstruction, chatModelReadsImages, visitorImagesEnabled, ...liveSettings } = settings
  void [customInstruction, chatModelReadsImages, visitorImagesEnabled]
  return liveSettings
}

type SaveState = { state: 'idle' | 'saved' | 'saving' | 'error'; message?: string | null }

export function WorkspaceAssistantChannelsTab({
  accountId,
  mode,
  agentId,
  agentSection,
  routeState,
  profileHref,
  onSaveStateChange,
  onDraftDirtyChange,
}: {
  accountId: string
  mode: 'workspace' | 'assistant' | 'channels'
  agentId?: string
  /** When set, render only this section (the second column owns selection). */
  agentSection?: AgentSectionId
  routeState?: DashboardRouteState
  profileHref?: string
  onSaveStateChange?: (input: SaveState) => void
  onDraftDirtyChange?: (dirty: boolean) => void
}) {
  const { logout } = useAuth()
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
  const { onRenamed, refresh: refreshAgents } = useAgents()
  const currentAgent = useAgentById(agentId)
  const channels = useAgentChannels()
  // The name the dashboard shows for this agent, as the agent area's list holds it (Profile only).
  const labelledAgent = mode === 'assistant' ? currentAgent : undefined
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
  const { saveError, setSaveState, setSaveError, saveSequenceRef } = useSettingsSaveStatus(onSaveStateChange)
  const dispatchDraftSaved = useCallback(() => {
    if (agentId) window.dispatchEvent(new CustomEvent(AGENT_DRAFT_SAVED_EVENT, { detail: { agentId } }))
  }, [agentId])
  const handleRevisionSaveStateChange = useCallback((next: SaveState) => {
    onSaveStateChange?.(next)
    if (next.state === 'saved') dispatchDraftSaved()
  }, [dispatchDraftSaved, onSaveStateChange])
  const [assistantSettingsError, setAssistantSettingsError] = useState<string | null>(null)
  const [assistantLocaleInput, setAssistantLocaleInput] = useState(NO_GREETING_LOCALE_LABEL)
  const [whatsappSetupOpen, setWhatsappSetupOpen] = useState(false)
  // When the second column drives selection, render exactly one section and
  // skip the in-page channel index/back affordance.
  const showSection = (id: AgentSectionId) => !agentSection || agentSection === id
  const isChannelId = (id: AgentSectionId | undefined): id is ChannelId =>
    id === 'web-chat' || id === 'api-channel' || id === 'mcp-channel' || id === 'slack-channel' || id === 'whatsapp-channel'
    || id === 'email-channel'
  const resolvedChannel: ChannelId | null = isChannelId(agentSection) ? agentSection : null
  const organizationDraftVersionRef = useRef(0)
  const workspaceDraftVersionRef = useRef(0)
  const anonDraftVersionRef = useRef(0)
  // Bumped by every logo write so a settings save that started earlier cannot restore
  // the replaced logo URL, whose stored object the upload already deleted.
  const assistantLogoWriteRef = useRef(0)
  const assistantBehaviorDraftVersionRef = useRef(0)
  const liveBehaviorSaveRef = useRef(0)
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
    scope: 'draft' | 'live',
  ) => {
    if (!agentId) {
      throw new Error('Assistant behavior settings require an agent')
    }
    return agentsApi.updateBehaviorSettings(agentId, data, saved, scope)
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
    const logoWriteAtRequestStart = assistantLogoWriteRef.current
    try {
      const updated = await updateGeneralSettings({
        anonymousChatEnabled: enabled,
      })
      const hasNewerLogo = assistantLogoWriteRef.current !== logoWriteAtRequestStart
      setAnonSettings((current) => mergeGeneralSettingsSnapshot(current, updated, { hasNewerLogo }))
      setSavedAnonSettings((current) => mergeGeneralSettingsSnapshot(current, updated, { hasNewerLogo }))
      // Turning the public chat on or off changes what the menu's Channels row counts.
      channels.refresh()
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
      await logout()
    } catch (error) {
      setDeleteOrgError(getApiErrorMessage(error, 'Failed to delete the organization.'))
      setIsDeletingOrg(false)
    }
  }

  const operatorAgentName = getAgentOperatorLabel(labelledAgent, 'Agent')
  // Slack must use an empty label fallback so the workspace assistant name can still be used.
  const slackAgentName = getAgentOperatorLabel(labelledAgent, '') || anonSettings?.assistantName || ''

  // A rename from the agent menu writes the server's names, so the fields held here take them too;
  // otherwise the next autosave would write the old name back.
  useEffect(() => onRenamed((renamed) => {
    if (renamed.agentId !== agentId) return
    const names: Partial<GeneralSettings> = { assistantName: renamed.name, internalName: renamed.internalName }
    setAnonSettings((current) => current && { ...current, ...names })
    setSavedAnonSettings((current) => current && { ...current, ...names })
  }), [agentId, onRenamed])

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
      assistantLogoWriteRef.current += 1
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
      assistantLogoWriteRef.current += 1
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

  const hasPrivateInstructionChanges = Boolean(
    assistantBehaviorSettings
    && savedAssistantBehaviorSettings
    && (assistantBehaviorSettings.customInstruction !== savedAssistantBehaviorSettings.customInstruction || assistantBehaviorSettings.visitorImagesEnabled !== savedAssistantBehaviorSettings.visitorImagesEnabled),
  )
  const greetingDraft = useGreetingDraft({
    agentId: mode === 'assistant' ? agentId : undefined,
    agentDefaultLocale: anonSettings?.assistantDefaultLocale ?? 'en',
  })
  const hasDraftChanges = hasPrivateInstructionChanges || greetingDraft.dirty

  const hasLiveAssistantBehaviorChanges = Boolean(
    assistantBehaviorSettings
    && savedAssistantBehaviorSettings
    && JSON.stringify(liveAssistantBehaviorSettings(assistantBehaviorSettings))
      !== JSON.stringify(liveAssistantBehaviorSettings(savedAssistantBehaviorSettings)),
  )

  useEffect(() => {
    // Only the private instruction, the photo switch and the greeting wording are part of the agent
    // revision. Names and all other profile settings apply immediately and never enable Save Draft.
    onDraftDirtyChange?.(hasDraftChanges)
  }, [hasDraftChanges, onDraftDirtyChange])

  const writeDraftInstructions = useCallback(async (isLatest: () => boolean) => {
    if (!agentId || !assistantBehaviorSettings || !savedAssistantBehaviorSettings) return
    const updated = normalizeAssistantBehaviorSettingsByAgent(
      agentId,
      await updateAssistantBehaviorSettings(assistantBehaviorSettings, savedAssistantBehaviorSettings, 'draft'),
    )
    if (!isLatest()) {
      throw new Error('A newer draft save superseded this request.')
    }
    setSavedAssistantBehaviorSettings(updated)
    // Agent updates return a full record. Keep live fields currently being
    // edited rather than replacing them with the record returned by this
    // private-only save.
    setAssistantBehaviorSettings((current) => current ? { ...updated, ...current } : updated)
  }, [agentId, assistantBehaviorSettings, savedAssistantBehaviorSettings, updateAssistantBehaviorSettings])
  // The page's one draft save: instruction and greeting wording, each written only when changed.
  const draftWriter = useAgentDraftWriter({
    ready: Boolean(agentId && assistantBehaviorSettings && savedAssistantBehaviorSettings),
    hasInstructionChanges: hasPrivateInstructionChanges,
    hasGreetingChanges: greetingDraft.dirty,
    writeInstructions: writeDraftInstructions,
    writeGreeting: greetingDraft.save,
    onDraftMoved: dispatchDraftSaved,
    status: { saveError, setSaveState, setSaveError, setSettingsError: setAssistantSettingsError },
  })
  useAgentDraftSaver({ agentId: mode === 'assistant' ? agentId : undefined, save: draftWriter.write, isDirty: hasDraftChanges, onFailureResolved: draftWriter.releaseFailure })

  useEffect(() => {
    if (!accountId || isOrganizationLoading || !canManageOrganization) {
      return
    }
    const trimmed = organizationName.trim()
    if (trimmed === '' || trimmed === savedOrganizationName) {
      return
    }
    const timeout = window.setTimeout(() => {
      void (async () => {
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
      })()
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [accountId, canManageOrganization, isOrganizationLoading, organizationName, saveSequenceRef, savedOrganizationName, setSaveError, setSaveState])

  useEffect(() => {
    if (!activeWorkspace || !hasNameChange) {
      return
    }
    const trimmed = workspaceName.trim()
    const timeout = window.setTimeout(() => {
      void (async () => {
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
      })()
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [activeWorkspace, hasNameChange, renameWorkspace, saveSequenceRef, setSaveError, setSaveState, workspaceName])

  useEffect(() => {
    if (!anonSettings || !savedAnonSettings || !hasAssistantChanges) {
      return
    }
    const timeout = window.setTimeout(() => {
      void (async () => {
        const draftVersionAtRequestStart = anonDraftVersionRef.current
        const logoWriteAtRequestStart = assistantLogoWriteRef.current
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
          const hasNewerLogo = assistantLogoWriteRef.current !== logoWriteAtRequestStart
          const nameChanged = savedAnonSettings.assistantName !== updated.assistantName
          const internalNameChanged = (savedAnonSettings.internalName ?? '') !== (updated.internalName ?? '')
          setSavedAnonSettings((current) => mergeGeneralSettingsSnapshot(current, updated, { hasNewerLogo }))
          setAssistantSettingsError(null)
          // Both feed the agent switcher's label; either change should refresh it.
          if (nameChanged || internalNameChanged) void refreshAgents()
          if (anonDraftVersionRef.current === draftVersionAtRequestStart) {
            setAnonSettings((current) => mergeGeneralSettingsSnapshot(current, updated, { hasNewerLogo }))
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
      })()
    }, 700)
    return () => window.clearTimeout(timeout)
  }, [anonSettings, hasAssistantChanges, refreshAgents, saveSequenceRef, savedAnonSettings, setSaveError, setSaveState, updateGeneralSettings])

  useEffect(() => {
    if (!assistantBehaviorSettings || !savedAssistantBehaviorSettings || !hasLiveAssistantBehaviorChanges) {
      return
    }

    const timeout = window.setTimeout(() => {
      void (async () => {
        const saveId = liveBehaviorSaveRef.current + 1
        liveBehaviorSaveRef.current = saveId
        const liveAtSaveStart = assistantBehaviorSettings
        setSaveState('saving')
        setSaveError(null)
        try {
          const updated = normalizeAssistantBehaviorSettingsByAgent(
            agentId,
            await updateAssistantBehaviorSettings(liveAtSaveStart, savedAssistantBehaviorSettings, 'live'),
          )
          if (liveBehaviorSaveRef.current !== saveId) return
          // The live write must not turn an unsaved private instruction into a
          // saved-looking value when the endpoint returns the whole agent.
          setSavedAssistantBehaviorSettings((current) => current ? {
            ...updated,
            customInstruction: current.customInstruction, visitorImagesEnabled: current.visitorImagesEnabled,
          } : updated)
          setAssistantSettingsError(null)
          // The server computes whether the chat model reads images from the model just saved.
          setAssistantBehaviorSettings((current) => current ? { ...updated, ...current, chatModelReadsImages: updated.chatModelReadsImages } : updated)
          setSaveState('saved')
        } catch (error) {
          if (liveBehaviorSaveRef.current !== saveId) return
          console.error('Failed to update assistant behavior settings:', error)
          setAssistantSettingsError(getApiErrorMessage(error, 'Failed to update assistant settings.'))
          setSaveState('error')
          setSaveError('Failed to save changes')
        }
      })()
    }, 700)

    return () => window.clearTimeout(timeout)
  }, [
    agentId,
    assistantBehaviorSettings,
    hasLiveAssistantBehaviorChanges,
    savedAssistantBehaviorSettings,
    setSaveError,
    setSaveState,
    updateAssistantBehaviorSettings,
  ])

  const handleAnonymousChatTokenRotate = async () => {
    if (!anonSettings) return
    setIsAnonSaving(true)
    const logoWriteAtRequestStart = assistantLogoWriteRef.current
    try {
      const updated = agentId
        ? await agentsApi.rotateAnonymousChatToken(agentId)
        : await generalSettingsApi.rotateAnonymousChatToken({ auth: 'session' })
      const hasNewerLogo = assistantLogoWriteRef.current !== logoWriteAtRequestStart
      setAnonSettings((current) => mergeGeneralSettingsSnapshot(current, updated, { hasNewerLogo }))
      setSavedAnonSettings((current) => mergeGeneralSettingsSnapshot(current, updated, { hasNewerLogo }))
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

            {canManageOrganization ? (
              <SettingsCard
                icon={<Users className="h-5 w-5 text-primary" />}
                title="Members"
                description="Invite people and manage their organization and workspace access."
                headerEnd={
                  <Button asChild variant="outline" size="sm">
                    <Link href={buildDashboardHref(accountId, {
                      section: 'account',
                      accountTab: 'members',
                      workspaceId: activeWorkspaceId ?? undefined,
                      workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
                    })}>
                      Manage members
                    </Link>
                  </Button>
                }
              />
            ) : null}

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

            <ConversationRetentionCard id="data-retention" />

            <TimeZoneCard id="time-zone" />

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
                  greetingDraft={agentId ? greetingDraft : undefined}
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
            {agentId ? (
              <SkillList
                agentId={agentId} onDraftSaved={dispatchDraftSaved}
                assistantBehaviorSettings={assistantBehaviorSettings}
                isAssistantBehaviorLoading={isAssistantBehaviorLoading}
                onAssistantBehaviorDraft={updateAssistantBehaviorDraft}
              />
            ) : null}
          </section>
          ) : null}

          {mode === 'assistant' && agentId && showSection('context-variables') ? (
          <section id="assistant-context-variables" className="space-y-6 scroll-mt-24">
            <AssistantContextVariablesSection agentId={agentId} onSaveStateChange={onSaveStateChange} onEnablementSaved={dispatchDraftSaved} />
          </section>
          ) : null}

          {mode === 'assistant' && agentId && showSection('directives') ? (
          <section id="assistant-directives" className="space-y-6 scroll-mt-24">
            <AssistantDirectivesSection agentId={agentId} onSaveStateChange={handleRevisionSaveStateChange} />
          </section>
          ) : null}

          {mode === 'assistant' && agentId && showSection('routines') ? (
          <section id="assistant-routines" className="space-y-6 scroll-mt-24">
            <AssistantRoutinesSection
              accountId={accountId}
              agentId={agentId}
              routeState={routeState}
              onSaveStateChange={handleRevisionSaveStateChange}
              agentDefaultLocale={anonSettings?.assistantDefaultLocale ?? undefined}
            />
          </section>
          ) : null}

          {mode === 'channels' && agentId && agentSection === 'channels-overview' ? (
            <AgentChannelsOverview
              hrefForChannel={(channelId) => buildAgentSectionHref(accountId, routeState ?? { section: 'agents' }, agentId, agentSectionRoute(channelId))}
            />
          ) : null}

          {mode === 'channels' && isAnonLoading && agentSection !== 'channels-overview' ? (
          <section className="flex min-h-[320px] items-center justify-center">
            <LogoSpinner imageClassName="h-7 w-7" />
          </section>
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
              assistantLogoWriteRef={assistantLogoWriteRef}
              saveSequenceRef={saveSequenceRef}
              setSaveState={setSaveState}
              setSaveError={setSaveError}
              profileHref={profileHref}
              agentId={agentId}
            />
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'api-channel' ? (
          <section id="api-channel" className="space-y-6 scroll-mt-24">
            {agentId ? <ApiChannelCard agentId={agentId} /> : null}
            {agentId ? <VoiceChannelCard key={agentId} agentId={agentId} /> : null}
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'mcp-channel' ? (
          <section id="mcp-channel" className="space-y-6 scroll-mt-24">
            {agentId ? <McpChannelCard agentId={agentId} /> : null}
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

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'email-channel' ? (
          <section className="space-y-6 scroll-mt-24">
            <EmailChannelCard workspaceId={activeWorkspaceId} agentId={agentId} />
          </section>
          ) : null}

          {mode === 'channels' && !isAnonLoading && resolvedChannel === 'whatsapp-channel' ? (
          <section id="whatsapp-channel" className="space-y-6 scroll-mt-24">
            <SettingsCard
              icon={<MessageCircle className="h-5 w-5 text-primary" />}
              title="WhatsApp"
              description="One WhatsApp Business number serves the whole workspace, and the workspace's default agent answers it."
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
              onOpenChange={(open) => {
                setWhatsappSetupOpen(open)
                // Closing the setup is when a connection it saved starts to count in the agent menu.
                if (!open) channels.refresh()
              }}
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
                      disabled={!deleteConfirmValid || !canManageWorkspaceLifecycle}
                      loading={isDeleting} icon={<Trash2 />}
                    >
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
                      disabled={!deleteOrgConfirmValid || !canDeleteOrganization}
                      loading={isDeletingOrg} icon={<Trash2 />}
                    >
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

      </div>
    </SettingsTabShell>
  )
}
