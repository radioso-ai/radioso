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
