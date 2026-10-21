/**
 * The port extraction asks a model through. It knows the request and what can
 * go wrong with a reply, never which provider answers or how.
 */

/** What made the previous reply unusable, passed on the single retry. */
export type EnrichmentRetryCause = "truncated" | "unreadable" | "provider_error";

export interface DocumentEnrichmentRequest {
  workspaceId: string;
  documentId: string;
  documentRevision: number;
  prompt: string;
  documentRepresentation: string;
  /** The JSON Schema a reply must match. A provider that can enforce it does. */
  outputSchema: Record<string, unknown>;
  /** Present only on the retry. */
  retry?: { after: EnrichmentRetryCause };
}

export interface DocumentEnrichmentGateway {
  /** Resolves with the reply parsed as JSON; rejects with one of the errors below. */
  generate(request: DocumentEnrichmentRequest): Promise<{ model: string; output: unknown }>;
}

/**
 * The model answered, but its reply is not JSON: empty, cut off at the output
 * limit, or prose. `reason` names which, and is content-free by construction.
 */
export class EnrichmentReplyUnreadableError extends Error {
  constructor(readonly reason: "not_json" | "truncated" | "empty") {
    super(`enrichment_reply_${reason}`);
    this.name = "EnrichmentReplyUnreadableError";
  }
}

/** The request never produced a reply. `retryable` is false when a retry cannot change that. */
export class EnrichmentProviderError extends Error {
  readonly retryable: boolean;

  constructor(input: { retryable: boolean; cause?: unknown }) {
    super("enrichment_provider_error", { cause: input.cause });
    this.name = "EnrichmentProviderError";
    this.retryable = input.retryable;
  }
}
