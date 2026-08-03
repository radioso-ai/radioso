/**
 * Radioso's default hosted API. Point `baseUrl` somewhere else when your
 * workspace lives elsewhere:
 *
 * - `https://api-us.radioso.ai` — the US instance
 * - your own origin — a self-hosted deployment, e.g. `https://radioso.acme.com`
 *
 * A workspace API token is only valid against the instance that issued it, so
 * the base URL has to match where your data actually lives.
 */
export const DEFAULT_BASE_URL = "https://api.radioso.ai";

export interface RadiosoClientOptions {
  /** Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  apiToken: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
}

export interface InternalClientConfig {
  baseUrl: string;
  apiToken: string;
  fetch: typeof fetch;
  headers: Headers;
}

export const createClientConfig = (options: RadiosoClientOptions): InternalClientConfig => {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const apiToken = options.apiToken.trim();

  if (!baseUrl) {
    throw new Error("Radioso SDK requires a non-empty baseUrl.");
  }

  if (!apiToken) {
    throw new Error("Radioso SDK requires a non-empty apiToken.");
  }

  return {
    baseUrl,
    apiToken,
    fetch: options.fetch ?? fetch,
    headers: new Headers(options.headers),
  };
};
