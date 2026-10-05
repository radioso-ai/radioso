import { isValidTestExecutionId } from './dashboard-routes'

/** Which Test Chat view the route names, and which saved test the chat view names, if any. */
export type TestChatRoute =
  | { view: 'history' }
  | { view: 'chat'; executionId?: string }

/**
 * How `agent-view.tsx` writes a Test Chat navigation into browser history. `push` adds a new
 * entry Back can return to; `replace` rewrites the current one; `return` steps Back onto the
 * entry this navigation came from when one is there, and otherwise replaces.
 */
export type TestChatNavigation = 'push' | 'replace' | 'return'

type FollowRouteResult =
  | { action: 'none' }
  | { action: 'adopt'; executionId: string }
  | { action: 'reject' }
  | { action: 'open'; executionId: string }

/**
 * What Test Chat's "URL → loaded test" effect does with the route's id, given what (if
 * anything) is already loaded. The route is the source of truth: a route with no id but a
 * loaded test adopts (writes the loaded id back, e.g. returning from another tab or Back onto
 * an empty entry); a route naming the loaded test is a no-op; a route naming an id that is not
 * a UUID is rejected; any other id is opened.
 */
export const followRoute = (
  routeId: string | undefined,
  loadedId: string | undefined,
): FollowRouteResult => {
  if (routeId === undefined) {
    return loadedId !== undefined ? { action: 'adopt', executionId: loadedId } : { action: 'none' }
  }
  if (routeId === loadedId) return { action: 'none' }
  if (!isValidTestExecutionId(routeId)) return { action: 'reject' }
  return { action: 'open', executionId: routeId }
}

type RouteIdWrite = { write: false } | { write: true; executionId: string | null }

/**
 * What Test Chat's "loaded test → URL" effect writes, given the route's current id, what was
 * loaded the previous time this ran, and what is loaded now. `write: false` means leave the URL
 * alone: nothing changed, or a route id that already differs from what was previously loaded
 * names a link still opening and owns the URL until it settles, or the route already names the
 * current load. Otherwise it writes the current load's id (`null` clears it, e.g. New chat).
 */
export const routeIdForLoaded = (
  routeId: string | undefined,
  previousLoadedId: string | undefined,
  loadedId: string | undefined,
): RouteIdWrite => {
  if (loadedId === previousLoadedId) return { write: false }
  if (routeId !== undefined && routeId !== previousLoadedId) return { write: false }
  if (routeId === loadedId) return { write: false }
  return { write: true, executionId: loadedId ?? null }
}
