'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronLeft, RefreshCw, X } from 'lucide-react'

import { AgentCockpitNav, type AgentCockpitTab } from '@/components/dashboard/agent-cockpit-nav'
import { AgentRevisionTestChat } from '@/components/dashboard/agent-revision-test-chat'
import { AgentRevisionHistory } from '@/components/dashboard/agent-revision-history'
import { AgentRevisionHeader } from '@/components/dashboard/agent-revision-header'
import { AgentDeleteDialog } from '@/components/dashboard/agent-delete-dialog'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { RoutineHeaderActionsProvider, useRoutineHeaderState } from '@/components/dashboard/shared/routine-header-actions'
import { AddSkillHeaderButton, SkillsHeaderActionProvider } from '@/components/dashboard/shared/skills-header-action'
import { SaveStateIndicator } from '@/components/dashboard/shared/save-state-indicator'
import { WorkspaceAssistantChannelsTab } from '@/components/dashboard/settings/workspace-assistant-channels-tab'
import { Button } from '@/components/ui/button'
import {
  buildAgentSectionHref,
  buildDashboardHref,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
import type { TestChatNavigation, TestChatRoute } from '@/lib/test-chat-open-route'
import { AGENT_DELETE_ANCHOR, agentSectionFromRoute, agentSectionRoute, type AgentSectionId } from '@/lib/dashboard-areas'
import { useAgentChannels } from '@/lib/agent-channels-context'
import { useAgents } from '@/lib/agents-context'
import { getAgentOperatorLabel } from '@/lib/agent-label'
import {
  clearAgentCreationHandoff as rawClearAgentCreationHandoff,
  readAgentCreationHandoff as rawReadAgentCreationHandoff,
} from '@/lib/agent-creation-contributions'
import { useWorkspace } from '@/lib/workspace-context'
import { useCopilotEntity } from '@/lib/copilot-context'
import { choosePrivacyNotice } from '@/lib/privacy-notice'

type AgentPageSaveState = {
  state: 'idle' | 'saved' | 'saving' | 'error'
  message?: string | null
}

type AgentSectionMeta = { title: string; mode: 'assistant' | 'channels'; description?: string }

interface AgentCreationHandoffItem {
  title: string | null
  url: string
}

interface AgentCreationHandoff {
  agentId: string
  title: string
  description: string
  items: AgentCreationHandoffItem[]
  detectedLocale?: string | null
  detectedPrivacyPolicyUrl?: string | null
  createdAt: number
}

type ReadAgentCreationHandoff = (agentId: string | undefined) => AgentCreationHandoff | null
const readAgentCreationHandoff: ReadAgentCreationHandoff = rawReadAgentCreationHandoff
const clearAgentCreationHandoff: () => void = rawClearAgentCreationHandoff

/** Each non-chat agent section maps to a content mode and a column-3 title. */
const AGENT_SECTION_META: Record<Exclude<AgentSectionId, 'chat' | 'changes'>, AgentSectionMeta> = {
  profile: { title: 'Profile', mode: 'assistant' },
  skills: {
    title: 'Skills',
    mode: 'assistant',
    description: 'Named actions this agent can take — answer from knowledge, send email, post to Slack, call a webhook, or notify a human — usable in routines.',
  },
  'context-variables': {
    title: 'Context',
    mode: 'assistant',
    description: 'Host-defined context this agent can resolve for each visitor turn.',
  },
  directives: { title: 'Directives', mode: 'assistant' },
  routines: { title: 'Routines', mode: 'assistant' },
  'web-chat': {
    title: 'Web chat',
    mode: 'channels',
    description: 'How the chat looks and reads, and where visitors can reach it.',
  },
  'api-channel': { title: 'Agent API', mode: 'channels' },
  'mcp-channel': { title: 'MCP', mode: 'channels' },
  'slack-channel': { title: 'Slack', mode: 'channels' },
  'whatsapp-channel': { title: 'WhatsApp', mode: 'channels' },
  'email-channel': { title: 'Email', mode: 'channels' },
  'channels-overview': { title: 'Channels', mode: 'channels', description: 'Configure the channels where this agent can answer.' },
}

function AgentCreationHandoffBanner({
  summary,
  onDismiss,
}: {
  summary: AgentCreationHandoff
  onDismiss: () => void
}) {
  return (
    <div className="border-b border-border bg-background px-4 py-3 sm:px-6">
      <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-3">
            <div>
              <p className="text-sm font-medium">{summary.title}</p>
              <p className="mt-1 truncate text-sm text-muted-foreground">{summary.description}</p>
            </div>
            {summary.detectedLocale || summary.detectedPrivacyPolicyUrl ? (
              <div className="flex flex-wrap gap-2">
                {summary.detectedLocale ? (
                  <span className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    Language: {summary.detectedLocale}
                  </span>
                ) : null}
                {summary.detectedPrivacyPolicyUrl ? (
                  <span className="max-w-full truncate rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                    Privacy policy detected
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: '100%' }} />
            </div>
            {summary.items.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {summary.items.slice(0, 6).map((item, index) => (
                  <div key={`${item.url}-${index}`} className="min-w-0 rounded-md bg-muted/40 px-3 py-2">
                    <p className="truncate text-xs font-medium">{item.title || 'Untitled page'}</p>
                    <p className="truncate text-xs text-muted-foreground">{item.url}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onDismiss} aria-label="Dismiss agent creation summary">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function AgentSettingsDashboardPage({
  accountId,
  agentCreationHandoff,
  profileHref,
  dismissAgentCreationHandoff,
  meta,
  routeState,
  saveStateAccessory,
  cockpitNavigation,
  cockpitActions,
  backAction,
  section,
  selectedAgentId,
  onSaveStateChange,
  onDraftDirtyChange,
}: {
  accountId: string
  agentCreationHandoff: AgentCreationHandoff | null
  profileHref: string
  dismissAgentCreationHandoff: () => void
  meta: AgentSectionMeta
  routeState: DashboardRouteState
  saveStateAccessory: React.ReactNode
  cockpitNavigation: React.ReactNode
  cockpitActions: React.ReactNode
  /** A channel page links back to the Channels overview. */
  backAction: React.ReactNode
  section: Exclude<AgentSectionId, 'chat'>
  selectedAgentId: string
  onSaveStateChange: (state: AgentPageSaveState) => void
  onDraftDirtyChange: (dirty: boolean) => void
}) {
  const routineHeader = useRoutineHeaderState()
  const isRoutineDetail = section === 'routines' && Boolean(routeState.agentRoutineId)
  return (
    <DashboardPage
      title={isRoutineDetail ? routineHeader.title ?? 'Routine' : meta.title}
      // Only the absence of any registration reads as loading; a routine section that has
      // loaded and deliberately registered no subtitle (`null`) shows none.
      description={isRoutineDetail ? (routineHeader.description === undefined ? 'Loading…' : routineHeader.description) : meta.description}
      backAction={isRoutineDetail ? routineHeader.backAction ?? null : backAction}
      titleAccessory={saveStateAccessory}
      actions={
        <>
          {cockpitActions}
          {section === 'skills' ? <AddSkillHeaderButton /> : isRoutineDetail ? routineHeader.actions : null}
        </>
      }
      actionsClassName="w-full max-w-full justify-start sm:w-auto sm:justify-end"
      headerContent={cockpitNavigation}
      contentClassName="flex flex-col overflow-hidden p-0"
      contentScroll={false}
    >
      {section === 'profile' && agentCreationHandoff ? (
        <AgentCreationHandoffBanner summary={agentCreationHandoff} onDismiss={dismissAgentCreationHandoff} />
      ) : null}
      <WorkspaceAssistantChannelsTab
        accountId={accountId}
        mode={meta.mode}
        agentId={selectedAgentId}
        agentSection={section}
        routeState={routeState}
        profileHref={profileHref}
        onSaveStateChange={onSaveStateChange}
        onDraftDirtyChange={onDraftDirtyChange}
      />
    </DashboardPage>
  )
}

/** history.state key marking a Conversation history entry pushed over the Test Chat entry. */
const TEST_CHAT_HISTORY_OVER_CHAT = 'radiosoTestChatHistoryOverChat'
export function AgentView({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const router = useRouter()
  const { activeWorkspaceId, accounts } = useWorkspace()
  const { agents, status: agentsStatus, selectedAgent, reload: reloadAgents, deleteRequest, dismissDeleteRequest } = useAgents()
  const channels = useAgentChannels()
  const [saveState, setSaveState] = useState<AgentPageSaveState>({ state: 'idle' })
  const [isDraftDirty, setIsDraftDirty] = useState(false)
  const [testActionsContainer, setTestActionsContainer] = useState<HTMLDivElement | null>(null)
  const [testTitleContainer, setTestTitleContainer] = useState<HTMLDivElement | null>(null)
  const [agentCreationHandoff, setAgentCreationHandoff] = useState<AgentCreationHandoff | null>(null)

  // The agent list, the selected agent and what changes either live in the agent area's shared port,
  // which the sidebar's agent menu reads too: the two cannot disagree about which agent is open.
  const isAgentsLoading = agentsStatus === 'loading'
  const agentsError = agentsStatus === 'error' ? 'Failed to load agents' : null
  const selectedAgentId = selectedAgent?.id
  const profileHref = useMemo(
    () =>
      buildAgentSectionHref(accountId, routeState, selectedAgentId, {
        agentTab: 'behavior',
        anchor: 'assistant-profile',
      }),
    [accountId, routeState, selectedAgentId],
  )
  useCopilotEntity('agent', selectedAgentId, getAgentOperatorLabel(selectedAgent), true)
  const isAgentRouteCanonicalizing = Boolean(
    !isAgentsLoading &&
    !agentsError &&
    selectedAgentId &&
    routeState.agentId !== selectedAgentId,
  )
  const agentSelectionPending = isAgentsLoading || isAgentRouteCanonicalizing
  const agentSelectionUnavailable = Boolean(!isAgentsLoading && (agentsError || !selectedAgent))

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAgentCreationHandoff(readAgentCreationHandoff(selectedAgentId))
    }, 0)

    return () => window.clearTimeout(timeout)
  }, [selectedAgentId])

  const dismissAgentCreationHandoff = useCallback(() => {
    clearAgentCreationHandoff()
    setAgentCreationHandoff(null)
  }, [])

  useEffect(() => {
    if (isAgentsLoading || agentsError || !selectedAgentId || routeState.agentId === selectedAgentId) {
      return
    }

    // The one move to the selected agent: it is also where a deleted agent's page goes, replacing its
    // URL in the history. What the old URL held (a routine, a saved test) belonged to the old agent.
    router.replace(buildDashboardHref(accountId, {
      ...routeState,
      section: 'agents',
      agentId: selectedAgentId,
      agentRoutineId: undefined,
      agentTestExecutionId: undefined,
      agentTestChatView: undefined,
      anchor: undefined,
    }))
  }, [accountId, agentsError, isAgentsLoading, routeState, router, selectedAgentId])

  // The delete confirmation opens when the agent menu asks for an agent's, or when the link names it by
  // anchor, which means the selected agent's. The anchor is the URL's own state, so closing the
  // confirmation also clears it from the URL.
  const anchoredDelete = routeState.anchor === AGENT_DELETE_ANCHOR
  const deleteTarget = (deleteRequest ? agents.find((agent) => agent.id === deleteRequest) : anchoredDelete ? selectedAgent : null) ?? null
  const handleDeleteOpenChange = (open: boolean) => {
    if (open) return
    dismissDeleteRequest()
    if (anchoredDelete) router.replace(profileHref)
  }
  const accountRole = accounts.find((account) => account.accountId === accountId)?.role
  const canDeleteAgent = accountRole === 'owner' || accountRole === 'admin'

  const saveStateAccessory = <SaveStateIndicator saveState={saveState} />
  const section = agentSectionFromRoute(routeState)
  const onChannelPage = AGENT_SECTION_META[section === 'chat' || section === 'changes' ? 'profile' : section].mode === 'channels'
  const handleSaveStateChange = useCallback((next: AgentPageSaveState) => {
    setSaveState(next)
    // A channel page that saved may have turned a channel on or off, which the menu's Channels row shows.
    if (next.state === 'saved' && onChannelPage) channels.refresh()
  }, [channels, onChannelPage])
  const wasOnChannelPage = useRef(onChannelPage)
  useEffect(() => {
    // Leaving a channel page re-reads the channels, whichever control on it changed one.
    if (wasOnChannelPage.current && !onChannelPage) channels.refresh()
    wasOnChannelPage.current = onChannelPage
  }, [channels, onChannelPage])

  // Test chat has no tab: it is its own row in the agent menu, and Build owns the tab bar.
  const cockpitTab = (section: AgentSectionId): AgentCockpitTab | null =>
    section === 'profile' || section === 'directives' || section === 'routines' || section === 'skills' || section === 'context-variables'
      ? section
      : null

  const sectionHrefFor = (target: AgentSectionId) =>
    buildAgentSectionHref(accountId, routeState, selectedAgentId, agentSectionRoute(target))
  const agentVersionsHref = sectionHrefFor('changes')
  const evalsHref = buildDashboardHref(accountId, { ...routeState, section: 'eval', evalCaseId: undefined })
  const usageHref = buildDashboardHref(accountId, { ...routeState, section: 'account', accountTab: 'usage' })
  // The share link for one saved test: anyone in this workspace who can manage agents can open it.
  const testExecutionHref = useCallback((executionId: string) => buildDashboardHref(accountId, {
    ...routeState,
    ...agentSectionRoute('chat'),
    section: 'agents',
    agentId: selectedAgentId,
    agentRoutineId: undefined,
    anchor: undefined,
    agentTestExecutionId: executionId,
  }), [accountId, routeState, selectedAgentId])
  const testChatRoute: TestChatRoute = routeState.agentTestChatView === 'history'
    ? { view: 'history' }
    : { view: 'chat', executionId: routeState.agentTestExecutionId }
  // Test Chat knows what is loaded, not browser-history mechanics; this is the one place that
  // turns a navigation decision into a shallow history entry, with no server round trip.
  const navigateTestChat = useCallback((next: TestChatRoute, how: TestChatNavigation) => {
    const href = buildDashboardHref(accountId, {
      ...routeState,
      section: 'agents',
      agentId: selectedAgentId,
      agentRoutineId: undefined,
      anchor: undefined,
      agentTestChatView: next.view === 'history' ? 'history' : undefined,
      agentTestExecutionId: next.view === 'chat' ? next.executionId : undefined,
    })
    if (how === 'push') {
      // Marks a history entry as pushed over the chat, so leaving it can step back; the marker
      // travels with the entry through Back and Forward, which a component-wide flag could not follow.
      window.history.pushState(next.view === 'history' ? { [TEST_CHAT_HISTORY_OVER_CHAT]: true } : null, '', href)
      return
    }
    if (how === 'return' && (window.history.state as Record<string, unknown> | null)?.[TEST_CHAT_HISTORY_OVER_CHAT] === true) {
      window.history.back()
      return
    }
    if (how === 'replace') {
      // A replace rewrites the entry this render describes. Next applies a native push or Back to
      // the route a render later, so a write decided before it would land on the operator's new
      // entry; skip it, and Test Chat reconciles against the new route when it renders.
      const live = new URLSearchParams(window.location.search)
      const liveView = live.get('view') === 'history' ? 'history' : undefined
      if (liveView !== routeState.agentTestChatView || (live.get('testExecution') ?? undefined) !== routeState.agentTestExecutionId) return
    }
    window.history.replaceState(null, '', href)
  }, [accountId, routeState, selectedAgentId])

  const agentUnavailableContent = agentSelectionPending ? (
    <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      Loading agent...
    </div>
  ) : agentsError ? (
    <div className="flex min-h-48 flex-col items-start justify-center gap-3 p-6">
      <div>
        <p className="font-medium text-foreground">Unable to load agent</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Agent details could not be loaded. Try again before chatting or editing this agent.
        </p>
      </div>
      <Button type="button" variant="outline" onClick={() => void reloadAgents()}>
        Retry
      </Button>
    </div>
  ) : agents.length === 0 ? (
    <div className="flex min-h-64 flex-col items-start justify-center gap-4 p-6">
      <div className="max-w-xl">
        <p className="font-medium text-foreground">Create your first agent</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add an agent with its own identity, instructions, and channel settings.
        </p>
      </div>
    </div>
  ) : (
    <div className="flex min-h-48 flex-col items-start justify-center gap-3 p-6">
      <div>
        <p className="font-medium text-foreground">Agent not found</p>
        <p className="mt-1 text-sm text-muted-foreground">
          This agent may have been deleted or may not belong to the current workspace.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        onClick={() => router.push(buildDashboardHref(accountId, {
          ...routeState,
          section: 'agents',
          agentId: undefined,
          anchor: undefined,
        }))}
      >
        Open an agent
      </Button>
    </div>
  )

  const renderAgentUnavailablePage = (description: string) => (
    <DashboardPage
      title="Agent"
      description={agentsError ?? description}
      titleAccessory={saveStateAccessory}
      contentClassName="flex flex-col overflow-hidden p-0"
      contentScroll={false}
    >
      {agentUnavailableContent}
    </DashboardPage>
  )

  if (agentSelectionPending || agentSelectionUnavailable || !selectedAgent) {
    return (
      <>
        {renderAgentUnavailablePage('')}
      </>
    )
  }

  // The sidebar owns section selection; this view renders the route's section.
  const showRevisionActions = section === 'chat'
    || section === 'changes'
    || section === 'profile'
    || section === 'directives'
    || section === 'routines'
    || section === 'skills'
    || section === 'context-variables'
  const cockpitNavigation = showRevisionActions && section !== 'chat'
    ? <AgentCockpitNav activeTab={cockpitTab(section)} hrefForTab={sectionHrefFor} />
    : null
  const cockpitActions = showRevisionActions
    ? <AgentRevisionHeader key={selectedAgent.id} agentId={selectedAgent.id} saveState={saveState.state} canSaveDraft={isDraftDirty} testChatHref={sectionHrefFor('chat')} versionsHref={agentVersionsHref} />
    : null

  const settingsSection = section === 'chat' || section === 'changes' ? 'profile' : section
  const settingsMeta = AGENT_SECTION_META[settingsSection]
  const channelsBackAction = settingsMeta.mode === 'channels' && settingsSection !== 'channels-overview'
    ? (
      <Link href={sectionHrefFor('channels-overview')} className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ChevronLeft className="h-4 w-4" />
        Channels
      </Link>
    )
    : null
  const settingsPage = (
    <SkillsHeaderActionProvider>
      <RoutineHeaderActionsProvider>
        <AgentSettingsDashboardPage
          accountId={accountId}
          agentCreationHandoff={agentCreationHandoff}
          profileHref={profileHref}
          dismissAgentCreationHandoff={dismissAgentCreationHandoff}
          meta={settingsMeta}
          routeState={routeState}
          saveStateAccessory={saveStateAccessory}
          cockpitNavigation={cockpitNavigation}
          cockpitActions={section === 'chat' ? null : cockpitActions}
          backAction={channelsBackAction}
          section={settingsSection}
          selectedAgentId={selectedAgent.id}
          onSaveStateChange={handleSaveStateChange}
          onDraftDirtyChange={setIsDraftDirty}
        />
      </RoutineHeaderActionsProvider>
    </SkillsHeaderActionProvider>
  )
  return (
    <>
      <div className={section === 'chat' || section === 'changes' ? 'hidden' : 'flex min-h-0 min-w-0 flex-1 flex-col'} aria-hidden={section === 'chat' || section === 'changes'}>
        {settingsPage}
      </div>
      {section === 'chat' ? (
        <DashboardPage title={selectedAgent.name ? `${selectedAgent.name} Test Chat` : 'Test Chat'} titleAccessory={<div ref={setTestTitleContainer} className="min-w-0" />} titleAccessoryAlignment="center" actions={<>{cockpitActions}<div ref={setTestActionsContainer} /></>} actionsClassName="w-full max-w-full justify-start sm:w-auto sm:justify-end" headerContent={cockpitNavigation} contentClassName="min-h-0 overflow-hidden p-0" contentScroll={false}>
          <AgentRevisionTestChat
            key={selectedAgent.id}
            agentId={selectedAgent.id}
            workspaceId={activeWorkspaceId ?? selectedAgent.workspaceId}
            assistantName={selectedAgent?.name}
            privacyNotice={choosePrivacyNotice(selectedAgent?.branding?.privacyNotice, selectedAgent?.assistantDefaultLocale)}
            evalsHref={evalsHref}
            usageHref={usageHref}
            actionsContainer={testActionsContainer}
            titleContainer={testTitleContainer}
            route={testChatRoute}
            onNavigate={navigateTestChat}
            testExecutionHref={testExecutionHref}
          />
        </DashboardPage>
      ) : null}
      {section === 'changes' ? (
        <DashboardPage title="Agent versions" actions={cockpitActions} actionsClassName="w-full max-w-full justify-start sm:w-auto sm:justify-end" headerContent={cockpitNavigation}>
          <AgentRevisionHistory key={selectedAgent.id} agentId={selectedAgent.id} />
        </DashboardPage>
      ) : null}
      {deleteTarget ? (
        <AgentDeleteDialog
          agentId={deleteTarget.id}
          agentName={getAgentOperatorLabel(deleteTarget)}
          agentCount={agents.length}
          canDelete={canDeleteAgent}
          open
          onOpenChange={handleDeleteOpenChange}
        />
      ) : null}
    </>
  )
}
