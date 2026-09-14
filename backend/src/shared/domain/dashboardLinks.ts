import { appUrl } from "./appUrl.js";

/**
 * Operator-facing dashboard links. The shapes here mirror the route contract in
 * `frontend/lib/dashboard-routes.ts`; changing one without the other silently produces links
 * that resolve to the dashboard's not-found redirect.
 */

/**
 * The permalink for a conversation. A conversation is a `chat` history item selected by query
 * parameter on the Activity section — the detail pane loads it by id, so the link works even when
 * the conversation is absent from the list's current page or filter.
 *
 * `tab` is set explicitly: with it omitted the dashboard picks a lens at runtime and can move the
 * operator somewhere other than the conversation the link was about.
 */
export const conversationPermalink = (
  input: { workspacePublicRouteKey: string; conversationId: string },
  baseUrl?: string | null,
): string => {
  const url = appUrl(`/w/${encodeURIComponent(input.workspacePublicRouteKey)}/activity`, baseUrl);
  url.searchParams.set("tab", "all");
  url.searchParams.set("filter", "chat");
  url.searchParams.set("itemKind", "chat");
  url.searchParams.set("itemId", input.conversationId);
  return url.toString();
};
