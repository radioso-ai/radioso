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

export default function Home() {
  const router = useRouter()
  const { user, isAuthenticated, isBootstrapping } = useAuth()
  const { activeWorkspace, isLoading: isWorkspaceLoading } = useWorkspace()
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
    if (isAuthenticated && !isWorkspaceLoading && activeWorkspace && !isLandingAgentResolved) {
      return
    }

    const redirectHref = getHomeDashboardRedirectHref({
      accountId: user?.accountId,
      isAuthBootstrapping: isBootstrapping,
      isWorkspaceLoading,
      activeWorkspace,
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
    router,
    user?.accountId,
  ])

  const isLandingAgentLoading = Boolean(
    isAuthenticated &&
    !isWorkspaceLoading &&
    activeWorkspace &&
    (
      landingAgentState.workspaceId !== activeWorkspace.id ||
      !landingAgentState.isResolved
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
