/**
 * How teammates are named to each other on operator surfaces: the name a
 * person chose, or their email until they choose one. Visitor-facing surfaces
 * never use this — an email is private to the workspace.
 */
export const teammateLabel = (user: { displayName?: string | null; email: string }): string =>
  user.displayName ?? user.email
