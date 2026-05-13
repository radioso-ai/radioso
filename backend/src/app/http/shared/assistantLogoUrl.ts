export const buildPublicAssistantLogoUrl = (input: {
  token: string | null;
  hasLogo: boolean;
  publicChatBaseUrl?: string | null;
  forwardedPrefix?: string | null;
}): string | null => {
  if (!input.hasLogo || !input.token) {
    return null;
  }

  const appBaseUrl = input.publicChatBaseUrl?.replace(/\/chat(?:\/.*)?$/, "");
  const forwardedPrefix = input.forwardedPrefix?.trim().replace(/\/$/, "") ?? "";
  return `${forwardedPrefix || appBaseUrl || ""}/api/v1/public/chat/${encodeURIComponent(input.token)}/assistant-logo`;
};

