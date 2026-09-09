export const buildPublicAssistantLogoUrl = (input: {
  token: string | null;
  hasLogo: boolean;
  cacheKey?: string | null;
  publicChatBaseUrl?: string | null;
  forwardedPrefix?: string | null;
}): string | null => {
  if (!input.hasLogo || !input.token) {
    return null;
  }

  const appBaseUrl = input.publicChatBaseUrl?.replace(/\/chat(?:\/.*)?$/, "");
  const forwardedPrefix = input.forwardedPrefix?.trim().replace(/\/$/, "") ?? "";
  const url = `${forwardedPrefix || appBaseUrl || ""}/api/v1/public/chat/${encodeURIComponent(input.token)}/assistant-logo`;
  return input.cacheKey ? `${url}?v=${encodeURIComponent(input.cacheKey)}` : url;
};

/**
 * The operator-facing logo URL. It names the agent instead of a public launch token, so
 * it resolves for an agent whose visitor channels are all switched off — a launch token
 * only exists once a channel is enabled. The workspace travels in the query because the
 * dashboard renders this in an `<img>`, which cannot send the workspace header; it selects
 * a workspace and is still checked against the caller's account before anything is served.
 */
export const buildOperatorAssistantLogoUrl = (input: {
  agentId: string;
  workspaceId: string;
  hasLogo: boolean;
  cacheKey?: string | null;
  forwardedPrefix?: string | null;
}): string | null => {
  if (!input.hasLogo) {
    return null;
  }
  const query = new URLSearchParams({ workspaceId: input.workspaceId });
  if (input.cacheKey) {
    query.set("v", input.cacheKey);
  }
  const forwardedPrefix = input.forwardedPrefix?.trim().replace(/\/$/, "") ?? "";
  return `${forwardedPrefix}/api/v1/agents/${encodeURIComponent(input.agentId)}/assistant-logo?${query.toString()}`;
};

const hashCacheKeyPart = (value: string): string => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
};

export const buildAssistantLogoCacheKey = (logo: {
  objectPath: string;
  generation?: string | null;
  sizeBytes: number;
} | null): string | null => {
  if (!logo) {
    return null;
  }
  return [hashCacheKeyPart(logo.objectPath), logo.generation ?? "", logo.sizeBytes].join(":");
};
