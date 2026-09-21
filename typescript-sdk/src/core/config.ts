/**
 * Radioso's default hosted API. Point `baseUrl` somewhere else when your
 * workspace lives elsewhere:
 *
 * - `https://api-us.radioso.ai` — the US instance
 * - your own origin — a self-hosted deployment, e.g. `https://radioso.acme.com`
 *
 * A personal token or service-account credential is only valid against the
 * instance that issued it, so the base URL has to match where your data lives.
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

// Character loops rather than `/\/+$/`: an anchored greedy run backtracks quadratically on
// long slash runs, and the base URL is caller-supplied.
export const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
};

export const trimLeadingSlashes = (value: string): string => {
  let start = 0;
  while (start < value.length && value[start] === "/") {
    start += 1;
  }
  return value.slice(start);
};

export const createClientConfig = (options: RadiosoClientOptions): InternalClientConfig => {
  const baseUrl = trimTrailingSlashes((options.baseUrl ?? DEFAULT_BASE_URL).trim());
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
