/**
 * Chat turn route vocabulary shared across modules.
 *
 * Owned here (not in the chat module) because it is a cross-module domain
 * vocabulary: the chat turn loop resolves a route, the directive route policy
 * scopes built-in directives to routes, and authored directives (agents module)
 * scope themselves to routes. Keeping it in `shared/domain` lets every consumer
 * depend on the narrow vocabulary instead of reaching into the chat module.
 */
export const CHAT_TURN_ROUTE = {
  RETRIEVAL: "retrieval",
  SOCIAL_ONLY: "social_only",
  ASSISTANT_IDENTITY: "assistant_identity",
} as const;

export type ChatTurnRoute = (typeof CHAT_TURN_ROUTE)[keyof typeof CHAT_TURN_ROUTE];
