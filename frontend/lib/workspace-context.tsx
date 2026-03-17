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
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

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
        const targetId = list.find((w) => w.id === storedId)?.id ?? list[0]?.id ?? null

        if (targetId) {
          if (!activateWorkspaceToken(targetId)) {
            await workspaceApi.getWorkspaceToken(targetId)
          }
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
    if (!activateWorkspaceToken(workspaceId)) {
      await workspaceApi.getWorkspaceToken(workspaceId)
    }
    setActiveWorkspaceId(workspaceId)
  }, [])

  const createWorkspace = useCallback(async (name: string) => {
    const workspace = await workspaceApi.create(name)
    setWorkspaces((prev) => [...prev, workspace])
    await switchWorkspace(workspace.id)
    return workspace
  }, [switchWorkspace])

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
