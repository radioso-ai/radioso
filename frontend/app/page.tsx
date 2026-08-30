'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useAuth } from '@/lib/auth-context'
import { AuthPage } from '@/components/auth/auth-page'
import { LogoSpinner } from '@/components/ui/spinner'
import { getHomeDashboardRedirectHref } from '@/lib/home-dashboard-redirect'
import { useWorkspace } from '@/lib/workspace-context'
import { agentsApi } from '@/lib/api'
import { getLastSelectedAgentId, setLastSelectedAgentId } from '@/lib/agent-selection'
import { useWorkspaceOnboarding } from '@/lib/onboarding'

export default function Home() {
  const router = useRouter()
  const { user, isAuthenticated, isBootstrapping } = useAuth()
  const { activeWorkspace, workspaces, isLoading: isWorkspaceLoading } = useWorkspace()
  // The only signal that decides whether this login lands on the Agents chat
  // tab (first-run onboarding renders only there, see dashboard-shell.tsx's
  // `isAgentChatView` / `showFirstRun`) or the Inbox (the normal landing
  // section for every returning workspace).
  const onboarding = useWorkspaceOnboarding(activeWorkspace?.id ?? null, workspaces.length)
  const [landingAgentState, setLandingAgentState] = useState<{
    workspaceId: string | null
    agentId: string | null
    isResolved: boolean
  }>({
    workspaceId: null,
    agentId: null,
    isResolved: false,
  })

  useEffect(() => {
    if (isBootstrapping || !isAuthenticated || isWorkspaceLoading || !activeWorkspace) {
      return
    }

    let active = true
    const workspaceId = activeWorkspace.id

    const resolveLandingAgent = async () => {
      setLandingAgentState((current) => (
        current.workspaceId === workspaceId && current.isResolved
          ? current
          : { workspaceId, agentId: null, isResolved: false }
      ))

      const rememberedAgentId = getLastSelectedAgentId(workspaceId)

      try {
        const response = await agentsApi.listAgents()
        if (!active) {
          return
        }

        const selectedAgent = rememberedAgentId
          ? response.agents.find((agent) => agent.id === rememberedAgentId) ?? response.agents[0] ?? null
          : response.agents[0] ?? null

        if (selectedAgent) {
          setLastSelectedAgentId(workspaceId, selectedAgent.id)
        }

        setLandingAgentState({
          workspaceId,
          agentId: selectedAgent?.id ?? null,
          isResolved: true,
        })
      } catch {
        if (!active) {
          return
        }

        setLandingAgentState({
          workspaceId,
          agentId: rememberedAgentId,
          isResolved: true,
        })
      }
    }

    void resolveLandingAgent()

    return () => {
      active = false
    }
  }, [activeWorkspace, isAuthenticated, isBootstrapping, isWorkspaceLoading])

  useEffect(() => {
    const isLandingAgentResolved = activeWorkspace
      ? landingAgentState.workspaceId === activeWorkspace.id && landingAgentState.isResolved
      : false
    const isOnboardingResolved = activeWorkspace ? !onboarding.isLoading : false
    if (isAuthenticated && !isWorkspaceLoading && activeWorkspace && (!isLandingAgentResolved || !isOnboardingResolved)) {
      return
    }

    const redirectHref = getHomeDashboardRedirectHref({
      accountId: user?.accountId,
      isAuthBootstrapping: isBootstrapping,
      isWorkspaceLoading,
      activeWorkspace,
      section: onboarding.shouldShowFirstRun ? 'agents' : 'activity',
      agentId: landingAgentState.agentId,
    })

    if (redirectHref) {
      router.replace(redirectHref)
    }
  }, [
    activeWorkspace,
    isAuthenticated,
    isBootstrapping,
    isWorkspaceLoading,
    landingAgentState,
    onboarding.isLoading,
    onboarding.shouldShowFirstRun,
    router,
    user?.accountId,
  ])

  const isLandingAgentLoading = Boolean(
    isAuthenticated &&
    !isWorkspaceLoading &&
    activeWorkspace &&
    (
      landingAgentState.workspaceId !== activeWorkspace.id ||
      !landingAgentState.isResolved ||
      onboarding.isLoading
    ),
  )

  if (isBootstrapping || (isAuthenticated && (isWorkspaceLoading || isLandingAgentLoading))) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <AuthPage />
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <LogoSpinner imageClassName="h-7 w-7" />
    </div>
  )
}
