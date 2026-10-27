import { isPubliclyReachableHostname } from "../../shared/domain/publicNetwork.js";
import type { VoiceRuntimeCompletionsAddress } from "../../modules/voiceChannel/domain.js";
import type { VoiceVendor } from "../../shared/domain/voiceVendor.js";

/** Where the dashboard's catch-all proxy (`frontend/app/backend/[...path]/route.ts`) forwards to the backend. */
const BACKEND_PROXY_PATH = "/backend";
const API_PATH = "/api/v1";

/**
 * Whether `APP_BASE_URL` names an address the public internet — and so a vendor agent — can
 * reach. Judged structurally, from the URL's scheme and hostname alone: no network call. A vendor
 * agent sends the agent's bearer credential to this address, so only `https:` qualifies.
 */
export const isAppBaseUrlPubliclyReachable = (appBaseUrl: string): boolean => {
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" && isPubliclyReachableHostname(url.hostname);
};

/**
 * The chat-completions base URL a vendor agent posts one agent's turns to, reached the same way
 * every dashboard and embed request already is: through the dashboard's own `/backend` proxy,
 * under `APP_BASE_URL`. Its trailing slash is dropped and any path it is served under is kept; a
 * query string or fragment plays no part in the address. Null when `APP_BASE_URL` is unset or its
 * host is not reachable from the public internet, so nothing can be connected.
 */
export const voiceRuntimeCompletionsAddress = (appBaseUrl: string | undefined): VoiceRuntimeCompletionsAddress | null => {
  if (!appBaseUrl || !isAppBaseUrlPubliclyReachable(appBaseUrl)) return null;
  const url = new URL(appBaseUrl);
  const path = url.pathname.replace(/\/+$/u, "");
  const base = `${url.origin}${path}${BACKEND_PROXY_PATH}${API_PATH}`;
  return ({ agentId, vendor }: { agentId: string; vendor: VoiceVendor }) =>
    `${base}/agents/${encodeURIComponent(agentId)}/voice/${vendor}/v1`;
};
