/**
 * Validation and normalization for `AZURE_OPENAI_ENDPOINT`. Pure structural checks only — a
 * hostname suffix and a URL path shape, never product vocabulary — so this module can be
 * imported from `env.ts` (zod schema) without pulling in any env-parsing machinery itself.
 */

const AZURE_OPENAI_HOST_SUFFIXES = [".openai.azure.com", ".services.ai.azure.com"] as const;

/** Whether a hostname is an Azure OpenAI (or Azure AI Foundry) resource host. */
export const isAzureOpenAIHost = (hostname: string): boolean => {
  const lower = hostname.toLowerCase();
  return AZURE_OPENAI_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

/**
 * Whether a URL's path is one `normalizeAzureOpenAIEndpoint` can turn into `/openai/v1`: empty
 * (the bare resource host, with or without a trailing slash) or already exactly `/openai/v1`
 * (with or without a trailing slash) — the two forms the Azure portal shows.
 */
export const isNormalizableAzureOpenAIPath = (pathname: string): boolean => {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" || trimmed === "/openai/v1";
};

/**
 * Normalizes an already-validated Azure OpenAI endpoint (host checked by
 * {@link isAzureOpenAIHost}, path checked by {@link isNormalizableAzureOpenAIPath}) to
 * `https://<host>/openai/v1` — the one shape every downstream reader can rely on, regardless of
 * which of the two accepted forms the operator pasted from the Azure portal.
 */
export const normalizeAzureOpenAIEndpoint = (raw: string): string => {
  const url = new URL(raw);
  return `https://${url.host}/openai/v1`;
};
