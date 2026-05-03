interface RouteWorkspaceSyncInput {
  activeWorkspaceId: string | null
  requestedWorkspaceExists: boolean
  requestedWorkspaceId?: string
}

export const shouldWaitForRouteWorkspace = ({
  activeWorkspaceId,
  requestedWorkspaceExists,
  requestedWorkspaceId,
}: RouteWorkspaceSyncInput) => {
  if (!requestedWorkspaceId || activeWorkspaceId === requestedWorkspaceId) {
    return false
  }

  if (!requestedWorkspaceExists) {
    return false
  }

  return true
}

export const shouldRewriteToActiveWorkspace = ({
  activeWorkspaceId,
  requestedWorkspaceExists,
  requestedWorkspaceId,
}: RouteWorkspaceSyncInput) => {
  if (!activeWorkspaceId || activeWorkspaceId === requestedWorkspaceId) {
    return false
  }

  if (requestedWorkspaceId && !requestedWorkspaceExists) {
    return false
  }

  return true
}
