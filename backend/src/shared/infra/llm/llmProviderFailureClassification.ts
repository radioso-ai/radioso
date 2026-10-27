import { isProviderCredentialError } from "./providerErrors.js";
import { isProviderRequestTimeoutError } from "./providerTimeouts.js";

/**
 * Bounded reason an LLM provider call failed. Low-cardinality and provider-agnostic —
 * never prose, never a message. Used for observability (error reports, analytics
 * properties, outcome logs), never for product behavior.
 */
export type LlmProviderFailureKind =
  | "model_unavailable"
  | "auth_rejected"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_rejected";

export interface LlmProviderFailureClassification {
  readonly kind: LlmProviderFailureKind;
  /** The provider's HTTP status, when the failure carried one. */
  readonly status?: number;
  /** The provider's machine error code (never prose), when present. */
  readonly code?: string;
}

interface ProviderErrorShape {
  status?: number;
  code?: string;
  error?: { code?: string };
  cause?: unknown;
}

// A model/deployment name the platform key does not serve. Azure reports this as
// `DeploymentNotFound`; OpenAI's own hosted API reports an unknown model as
// `model_not_found`. Both are structural provider codes, not product vocabulary.
const MODEL_UNAVAILABLE_CODES = new Set(["DeploymentNotFound", "model_not_found"]);

// Node/undici errno codes for a provider endpoint that could not be reached at all.
// Structural transport codes (not English prose) — the same set regardless of locale.
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
]);

const codeOf = (error: ProviderErrorShape): string | undefined => error.code ?? error.error?.code;

/**
 * A fetch failure's own error (a `TypeError`) carries no `.code`; the transport
 * errno lives one level down, on `.cause` (Node's undici sets it there).
 */
const networkErrorCode = (error: ProviderErrorShape): string | undefined => {
  const ownCode = codeOf(error);
  if (ownCode && NETWORK_ERROR_CODES.has(ownCode)) {
    return ownCode;
  }
  const cause = error.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string" && NETWORK_ERROR_CODES.has(causeCode)) {
      return causeCode;
    }
  }
  return undefined;
};

/**
 * Classifies why an LLM provider call failed, from status codes and provider/transport
 * error codes only — never from message text. Returns `null` when `error` carries none
 * of these signals, i.e. it is not a provider-call failure at all (a programming error,
 * an `AppError`, or anything else the caller already handles on its own terms).
 */
export const classifyLlmProviderFailure = (error: unknown): LlmProviderFailureClassification | null => {
  if (isProviderRequestTimeoutError(error)) {
    return { kind: "provider_unavailable" };
  }
  if (!error || typeof error !== "object") {
    return null;
  }

  const shaped = error as ProviderErrorShape;
  const status = typeof shaped.status === "number" ? shaped.status : undefined;
  const code = codeOf(shaped);

  if (isProviderCredentialError(error)) {
    return { kind: "auth_rejected", status, code };
  }
  if (status === 404 || (code !== undefined && MODEL_UNAVAILABLE_CODES.has(code))) {
    return { kind: "model_unavailable", status, code };
  }
  if (status === 429) {
    return { kind: "rate_limited", status, code };
  }
  if (status !== undefined && status >= 500) {
    return { kind: "provider_unavailable", status, code };
  }
  const transportCode = networkErrorCode(shaped);
  if (transportCode) {
    return { kind: "provider_unavailable", code: transportCode };
  }
  if (status !== undefined && status >= 400) {
    return { kind: "provider_rejected", status, code };
  }
  return null;
};
