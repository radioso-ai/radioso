'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { agentsApi, type AgentSettings } from '@/lib/api'
import { getLastSelectedAgentId, setLastSelectedAgentId } from '@/lib/agent-selection'

/**
 * `loading` until the first read (or a read the caller waits for) lands, `ready` once there is a list
 * to show, `error` when a read failed and there is no earlier list to fall back on.
 */
export type AgentsStatus = 'loading' | 'ready' | 'error'

export interface AgentNames {
  /** What visitors call the agent. */
  name: string
  /** What the dashboard calls it; empty means the visitor-facing name is used. */
  internalName: string
}

interface AgentRenamed extends AgentNames {
  agentId: string
}

/**
 * The agent area's one view of the workspace's agents: the list, which agent is selected, and the
 * actions that change either. The sidebar's agent menu, the agent view, the dialogs the menu opens
 * and the pages under them all read and write through this, so none of them keeps a list of its own.
 */
export interface AgentsPort {
  agents: AgentSettings[]
  status: AgentsStatus
  /** The agent the route names, else the last one the operator used, else the first. */
  selectedAgent: AgentSettings | null
  /** Reads the list again without disturbing what is on screen; a failed read keeps the last list. */
  refresh: () => Promise<void>
  /** Reads the list again and reports `loading` until it lands, for a caller that must not act on a stale list. */
  reload: () => Promise<void>
  createAgent: (name: string) => Promise<AgentSettings>
  renameAgent: (agentId: string, names: AgentNames) => Promise<void>
  /** Deletes the agent and selects the one that takes its place. */
  deleteAgent: (agentId: string) => Promise<void>
  /** The agent whose delete confirmation is open, if any. */
  deleteRequest: string | null
  requestDelete: (agentId: string) => void
  dismissDeleteRequest: () => void
  /** Told after a rename the menu made, so a Profile page that is open takes the new names. */
  onRenamed: (listener: (renamed: AgentRenamed) => void) => () => void
}

const unavailable = async (): Promise<never> => {
  throw new Error('The agent area is not mounted')
}

// Outside the provider (the workspace settings page, a unit test) there are no agents to speak of.
const detachedPort: AgentsPort = {
  agents: [],
  status: 'loading',
  selectedAgent: null,
  refresh: async () => undefined,
  reload: async () => undefined,
  createAgent: unavailable,
  renameAgent: unavailable,
  deleteAgent: unavailable,
  deleteRequest: null,
  requestDelete: () => undefined,
  dismissDeleteRequest: () => undefined,
  onRenamed: () => () => undefined,
}

const AgentsContext = createContext<AgentsPort>(detachedPort)

export const useAgents = (): AgentsPort => useContext(AgentsContext)

/** One agent from the area's list, for a page that only needs to know what the dashboard calls it. */
export const useAgentById = (agentId: string | undefined): AgentSettings | undefined => {
  const { agents } = useAgents()
  return useMemo(() => agents.find((agent) => agent.id === agentId), [agents, agentId])
}

interface AgentsState {
  workspaceId: string | null
  agents: AgentSettings[]
  status: AgentsStatus
}

const emptyState = (workspaceId: string | null): AgentsState => ({ workspaceId, agents: [], status: 'loading' })

export function AgentsProvider({
  workspaceId,
  routeAgentId,
  enabled,
  children,
}: {
  workspaceId: string | null
  /** The agent the URL names, if it names one. */
  routeAgentId: string | undefined
  /** The list is only read while the agent area is on screen. */
  enabled: boolean
  children: ReactNode
}) {
  const [state, setState] = useState<AgentsState>(() => emptyState(workspaceId))
  const [deleteRequest, setDeleteRequest] = useState<string | null>(null)
  const renamedListeners = useRef(new Set<(renamed: AgentRenamed) => void>())
  /** Counts reads, so a read that is overtaken by a newer one is dropped. */
  const readGeneration = useRef(0)
  /** Every agent id a list has held, so a route naming a deleted agent is told apart from one the list has not met yet. */
  const seenAgentIds = useRef(new Set<string>())
  const current = state.workspaceId === workspaceId ? state : emptyState(workspaceId)

  const read = useCallback(async (waitFor: boolean) => {
    if (!workspaceId) return
    const generation = ++readGeneration.current
    if (waitFor) setState((previous) => ({ ...(previous.workspaceId === workspaceId ? previous : emptyState(workspaceId)), status: 'loading' }))
    try {
      const response = await agentsApi.listAgents()
      if (readGeneration.current !== generation) return
      response.agents.forEach((agent) => seenAgentIds.current.add(agent.id))
      setState({ workspaceId, agents: response.agents, status: 'ready' })
    } catch {
      if (readGeneration.current !== generation) return
      // A failed read never takes away a list that already loaded.
      setState((previous) => {
        const agents = previous.workspaceId === workspaceId ? previous.agents : []
        return { workspaceId, agents, status: agents.length > 0 ? 'ready' : 'error' }
      })
    }
  }, [workspaceId])

  const refresh = useCallback(() => read(false), [read])
  const reload = useCallback(() => read(true), [read])

  useEffect(() => {
    if (!enabled || !workspaceId) return
    const timeout = window.setTimeout(() => { void read(false) }, 0)
    return () => window.clearTimeout(timeout)
    // The first read for a workspace; later reads are asked for by name.
  }, [enabled, read, workspaceId])

  const agents = current.agents
  useEffect(() => {
    // The route names an agent no list has held (created elsewhere): read again before anything acts
    // on the guess that follows. An agent this list once held and lost was deleted, and is not asked for.
    if (!enabled || !workspaceId || current.status === 'loading' || !routeAgentId) return
    if (agents.some((agent) => agent.id === routeAgentId) || seenAgentIds.current.has(routeAgentId)) return
    const timeout = window.setTimeout(() => {
      seenAgentIds.current.add(routeAgentId)
      void read(true)
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [agents, current.status, enabled, read, routeAgentId, workspaceId])

  const rememberedAgentId = getLastSelectedAgentId(workspaceId)
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === routeAgentId)
      ?? agents.find((agent) => agent.id === rememberedAgentId)
      ?? agents[0]
      ?? null,
    [agents, rememberedAgentId, routeAgentId],
  )
  const selectedAgentId = selectedAgent?.id
  useEffect(() => {
    if (enabled && selectedAgentId) setLastSelectedAgentId(workspaceId, selectedAgentId)
  }, [enabled, selectedAgentId, workspaceId])

  const createAgent = useCallback(async (name: string) => {
    const created = await agentsApi.createAgent({ name })
    setLastSelectedAgentId(workspaceId, created.id)
    seenAgentIds.current.add(created.id)
    setState((previous) => {
      const known = previous.workspaceId === workspaceId ? previous.agents : []
      return { workspaceId, agents: [...known.filter((agent) => agent.id !== created.id), created], status: 'ready' }
    })
    return created
  }, [workspaceId])

  const renameAgent = useCallback(async (agentId: string, names: AgentNames) => {
    const updated = await agentsApi.updateAgent(agentId, { name: names.name, internalName: names.internalName })
    const renamed: AgentRenamed = { agentId, name: updated.name ?? names.name, internalName: updated.internalName ?? names.internalName }
    setState((previous) => previous.workspaceId !== workspaceId ? previous : {
      ...previous,
      agents: previous.agents.map((agent) => agent.id === agentId ? { ...agent, name: renamed.name, internalName: renamed.internalName } : agent),
    })
    renamedListeners.current.forEach((listener) => listener(renamed))
  }, [workspaceId])

  const deleteAgent = useCallback(async (agentId: string) => {
    await agentsApi.deleteAgent(agentId)
    const remaining = agents.filter((agent) => agent.id !== agentId)
    // Say who takes over before the list changes, so the selection moves once, to that agent.
    if (remaining[0]) setLastSelectedAgentId(workspaceId, remaining[0].id)
    setDeleteRequest(null)
    setState((previous) => previous.workspaceId !== workspaceId ? previous : { ...previous, agents: previous.agents.filter((agent) => agent.id !== agentId) })
  }, [agents, workspaceId])

  const requestDelete = useCallback((agentId: string) => setDeleteRequest(agentId), [])
  const dismissDeleteRequest = useCallback(() => setDeleteRequest(null), [])
  const onRenamed = useCallback((listener: (renamed: AgentRenamed) => void) => {
    renamedListeners.current.add(listener)
    return () => { renamedListeners.current.delete(listener) }
  }, [])

  const port = useMemo<AgentsPort>(() => ({
    agents,
    status: current.status,
    selectedAgent,
    refresh,
    reload,
    createAgent,
    renameAgent,
    deleteAgent,
    deleteRequest,
    requestDelete,
    dismissDeleteRequest,
    onRenamed,
  }), [agents, createAgent, current.status, deleteAgent, deleteRequest, dismissDeleteRequest, onRenamed, refresh, reload, renameAgent, requestDelete, selectedAgent])

  return <AgentsContext.Provider value={port}>{children}</AgentsContext.Provider>
}
