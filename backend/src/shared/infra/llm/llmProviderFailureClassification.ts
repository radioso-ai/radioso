import OpenAI from "openai";

import { isProviderCredentialError, machineCode, ProviderHttpError } from "./providerErrors.js";
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

/**
 * Whether `error` is itself a type a model-provider call adapter is known to throw.
 * This is the gate `classifyLlmProviderFailure` requires before it reads anything
 * status/code-shaped off an error: the shape alone (`{status, code}`) is not
 * provider-specific — a Postgres connection error, an MCP credential rejection, or any
 * REST client can carry the identical fields, and classifying those as an LLM provider
 * failure would mislabel the real fault. The OpenAI SDK's `APIError` covers every one
 * of its subclasses (auth, rate limit, not-found, 5xx, connection, timeout, abort) in a
 * single check; `ProviderHttpError` is this repo's own type for the raw fetch-based
 * Gemini/Claude adapters' HTTP-status failures.
 */
const isKnownProviderErrorType = (error: unknown): boolean =>
  error instanceof OpenAI.APIError || error instanceof ProviderHttpError || isProviderRequestTimeoutError(error);

const codeOf = (error: ProviderErrorShape): string | undefined => machineCode(error.code) ?? machineCode(error.error?.code);

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
 * Classifies a single error value by its own shape — never its `.cause`, and never
 * whether it is a known provider type (the caller already decided that for the whole
 * chain). Split out of {@link classifyLlmProviderFailure} so that function owns the one
 * place the chain walks.
 */
const classifySingleError = (error: unknown): LlmProviderFailureClassification | null => {
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

// How many `.cause` hops past the original error this still looks at. A generic turn-
// level wrapper (`RoutineActivationFailure`, a plain `Error` with no provider shape of
// its own) carries the real provider error one hop down; this stays small because a
// cause chain is attacker- or library-controlled depth, not something to walk unbounded.
const MAX_CAUSE_CHAIN_DEPTH = 3;

/** The error itself, then up to {@link MAX_CAUSE_CHAIN_DEPTH} hops of `.cause`, cycle-safe. */
const causeChainNodes = (error: unknown): unknown[] => {
  const nodes: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSE_CHAIN_DEPTH; depth += 1) {
    if (current === null || current === undefined || visited.has(current)) {
      break;
    }
    visited.add(current);
    nodes.push(current);
    current = typeof current === "object" && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return nodes;
};

/**
 * Classifies why an LLM provider call failed, walking `.cause` (bounded, cycle-safe) when
 * the error itself carries no provider shape — a turn-level wrapper such as
 * `RoutineActivationFailure` is a plain `Error` whose `.cause` is the actual provider
 * error. Classifies from status codes and provider/transport error codes only, never
 * from message text at any depth. Requires a known provider error type (see
 * {@link isKnownProviderErrorType}) somewhere in the chain before classifying anything
 * by shape — otherwise a non-LLM failure that happens to carry a `status`/`code` (a
 * database connection error, an MCP credential rejection, any REST client's 404) would
 * read as an LLM provider failure. Returns `null` when nothing in the chain carries a
 * provider shape, i.e. none of it is a provider-call failure (a programming error, an
 * `AppError`, or anything else the caller already handles on its own terms).
 */
export const classifyLlmProviderFailure = (error: unknown): LlmProviderFailureClassification | null => {
  const nodes = causeChainNodes(error);
  if (!nodes.some(isKnownProviderErrorType)) {
    return null;
  }
  for (const node of nodes) {
    const classified = classifySingleError(node);
    if (classified) {
      return classified;
    }
  }
  return null;
};
