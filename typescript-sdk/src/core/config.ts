export interface RadiosoClientOptions {
  baseUrl: string;
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
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
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
