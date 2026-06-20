export const resolvePublicChatSessionSecret = (env: {
  NODE_ENV: string;
  PUBLIC_CHAT_SESSION_SECRET?: string;
  WEBSITE_EMBED_SECRET?: string;
  WORKSPACE_TOKEN_SECRET?: string;
}) => {
  if (env.PUBLIC_CHAT_SESSION_SECRET) {
    return env.PUBLIC_CHAT_SESSION_SECRET;
  }

  // Backward compatibility for env files generated before the public-chat
  // session secret was renamed.
  if (env.WEBSITE_EMBED_SECRET) {
    return env.WEBSITE_EMBED_SECRET;
  }

  // Local Docker/dev setups already require WORKSPACE_TOKEN_SECRET; use it as a dev-only fallback
  // so public chat works out of the box without weakening deployed environments.
  if (env.NODE_ENV === "development") {
    return env.WORKSPACE_TOKEN_SECRET;
  }

  return undefined;
};
