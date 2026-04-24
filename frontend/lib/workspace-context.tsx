'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import {
  workspaceApi,
  activateWorkspaceToken,
  clearWorkspaceStorage,
  removeWorkspaceToken,
  getStoredActiveWorkspaceId,
  type Workspace,
} from '@/lib/api'
import { useAuth } from '@/lib/auth-context'

interface WorkspaceContextValue {
  workspaces: Workspace[]
  activeWorkspace: Workspace | null
  activeWorkspaceId: string | null
  isLoading: boolean
  switchWorkspace: (workspaceId: string) => Promise<void>
  createWorkspace: (name: string) => Promise<Workspace>
  renameWorkspace: (workspaceId: string, name: string) => Promise<Workspace>
  deleteWorkspace: (workspaceId: string) => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export const resolveBootstrapWorkspaceId = (
  workspaces: Workspace[],
  storedWorkspaceId: string | null,
): string | null => {
  const storedMatch = workspaces.find((workspace) => workspace.id === storedWorkspaceId)
  if (storedMatch) {
    return storedMatch.id
  }

  const defaultWorkspace = workspaces.find((workspace) => workspace.name === 'Default')
  if (defaultWorkspace) {
    return defaultWorkspace.id
  }

  return workspaces.at(-1)?.id ?? null
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, isBootstrapping, logout } = useAuth()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (isBootstrapping) return

    if (!user) {
      setWorkspaces([])
      setActiveWorkspaceId(null)
      setIsLoading(false)
      return
    }

    let cancelled = false

    const bootstrap = async () => {
      try {
        const list = await workspaceApi.list()
        if (cancelled) return

        setWorkspaces(list)

        const storedId = getStoredActiveWorkspaceId()
        const targetId = resolveBootstrapWorkspaceId(list, storedId)

        if (targetId) {
          const targetWorkspace = list.find((workspace) => workspace.id === targetId) ?? null
          activateWorkspaceToken(targetId, targetWorkspace?.publicRouteKey)
          setActiveWorkspaceId(targetId)
        }
      } catch {
        if (!cancelled) logout()
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void bootstrap()
    return () => { cancelled = true }
  }, [user, isBootstrapping, logout])

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId) ?? null
    activateWorkspaceToken(workspaceId, workspace?.publicRouteKey)
    setActiveWorkspaceId(workspaceId)
  }, [workspaces])

  const createWorkspace = useCallback(async (name: string) => {
    const workspace = await workspaceApi.create(name)
    setWorkspaces((prev) => [...prev, workspace])
    activateWorkspaceToken(workspace.id, workspace.publicRouteKey)
    setActiveWorkspaceId(workspace.id)
    return workspace
  }, [])

  const renameWorkspace = useCallback(async (workspaceId: string, name: string) => {
    const updated = await workspaceApi.rename(workspaceId, name)
    setWorkspaces((prev) => prev.map((w) => (w.id === workspaceId ? updated : w)))
    return updated
  }, [])

  const deleteWorkspace = useCallback(async (workspaceId: string) => {
    await workspaceApi.delete(workspaceId)
    removeWorkspaceToken(workspaceId)
    const remaining = workspaces.filter((w) => w.id !== workspaceId)
    setWorkspaces(remaining)
    if (workspaceId === activeWorkspaceId && remaining.length > 0) {
      await switchWorkspace(remaining[0].id)
    }
  }, [workspaces, activeWorkspaceId, switchWorkspace])

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        activeWorkspace,
        activeWorkspaceId,
        isLoading,
        switchWorkspace,
        createWorkspace,
        renameWorkspace,
        deleteWorkspace,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext)
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider')
  }
  return context
}
