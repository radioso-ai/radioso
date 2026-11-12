// Structural path checks only; they carry no product vocabulary.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/u

/**
 * A `.` or `..` segment, raw or percent-encoded, walks out of the workspace once the path is
 * prefixed with the workspace root, so the path is decoded before its segments are checked.
 */
const hasDotSegment = (path: string): boolean => {
  const pathname = path.split(/[?#]/u, 1)[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return true
  }
  return decoded.includes('\\') || decoded.split('/').some((segment) => segment === '.' || segment === '..')
}

/**
 * Where a contributed proposal's dashboard link opens, inside the workspace's own dashboard, or null
 * when the path would leave it. The backend refuses such a path when the proposal is drafted; this
 * checks again where the link is built.
 */
export const workspaceDashboardHref = (workspaceRouteKey: string, dashboardPath: string): string | null => {
  if (!dashboardPath.startsWith('/') || dashboardPath.startsWith('//') || dashboardPath.includes('\\')) return null
  if (CONTROL_OR_SPACE.test(dashboardPath) || hasDotSegment(dashboardPath)) return null
  return `/w/${encodeURIComponent(workspaceRouteKey)}${dashboardPath}`
}
