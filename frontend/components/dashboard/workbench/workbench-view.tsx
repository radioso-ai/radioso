'use client'

import type { ReactNode } from 'react'

import { ChatView } from '@/components/dashboard/chat-view'
import { DashboardPage } from '@/components/dashboard/shared/dashboard-page'
import { LogoSpinner } from '@/components/ui/spinner'
import type { AgentSettings } from '@/lib/api'
import type { DashboardRouteState } from '@/lib/dashboard-routes'
import type { WorkspaceOnboardingState } from '@/lib/onboarding'
import { WorkbenchCompare } from './workbench-compare'
import { WorkbenchOverridePanel } from './workbench-override-panel'
import { WorkbenchRunStrip } from './workbench-run-strip'
import { TrainingView } from './training-view'
import { useWorkbenchState } from './use-workbench-state'

interface WorkbenchViewProps {
  accountId: string
  agentId?: string
  assistantName?: string | null
  assistantLinkUtmEnabled?: boolean
  onOpenDocument: (documentId: string) => void
  onboarding: WorkspaceOnboardingState
  navigation?: ReactNode
  selectedAgent: AgentSettings
  routeState: DashboardRouteState
}

export function WorkbenchView({
  accountId,
  agentId,
  assistantName,
  assistantLinkUtmEnabled,
  onOpenDocument,
  onboarding,
  navigation,
  selectedAgent,
  routeState,
}: WorkbenchViewProps) {
  const seed = routeState.workbenchConversationId
    ? {
      conversationId: routeState.workbenchConversationId,
      sourceMessageId: routeState.workbenchMessageId,
    }
    : undefined
  const state = useWorkbenchState({ selectedAgent, seed })

  if (state.isDeltaEmpty && !seed) {
    return (
      <ChatView
        key={agentId}
        accountId={accountId}
        agentId={agentId}
        assistantName={assistantName}
        assistantLinkUtmEnabled={assistantLinkUtmEnabled}
        onOpenDocument={onOpenDocument}
        onboarding={onboarding}
        navigation={navigation}
      />
    )
  }

  return (
    <DashboardPage
      title="Workbench"
      description={seed ? 'Replay a captured turn with temporary agent overrides.' : 'Load a past turn to start a replay.'}
      contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
      contentScroll={false}
    >
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,340px)_minmax(0,1fr)]">
        <WorkbenchOverridePanel
          baseline={state.baseline}
          state={state.overrideState}
          dispatch={state.dispatchOverride}
        />
        <main className="min-h-0 overflow-y-auto p-4">
          {state.isSeedLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <LogoSpinner className="mr-2 h-4 w-4" />
              Loading replay seed...
            </div>
          ) : (
            <div className="space-y-6">
              {state.error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {state.error}
                </div>
              ) : null}
              {state.seedTurn ? (
                <TrainingView
                  selectedAgent={selectedAgent}
                  seedTurn={state.seedTurn}
                  onOpenDocument={onOpenDocument}
                />
              ) : null}
              <WorkbenchCompare
                originalTurn={state.seedTurn?.assistantTurn ?? null}
                latestRun={state.runs[0] ?? null}
                onOpenDocument={onOpenDocument}
              />
              <WorkbenchRunStrip
                runs={state.runs}
                isRunning={state.isRunning}
                disabled={!state.seedTurn || state.isDeltaEmpty}
                onRun={state.runReplay}
                conversationId={state.seedTurn?.conversation.conversationId}
                conversationMessages={state.seedTurn?.conversation.messages}
                assistantMessageId={state.seedTurn?.assistantTurn?.id}
                userQueryPreview={state.seedTurn?.userTurn.content}
                onOpenDocument={onOpenDocument}
              />
            </div>
          )}
        </main>
      </div>
    </DashboardPage>
  )
}
