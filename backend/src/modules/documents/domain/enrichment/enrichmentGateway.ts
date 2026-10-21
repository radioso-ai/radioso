/**
 * The port extraction asks a model through. It knows the request and what can
 * go wrong with a reply, never which provider answers or how.
 */

/**
 * What made the previous reply unusable, passed on the single retry. A reply
 * cut off at the output limit needs more room; any other is asked again as is.
 */
export type EnrichmentRetryCause = "truncated" | "unreadable";

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

/**
 * The request never produced a reply. Transient transport failures are the
 * adapter's to retry, so by the time this is raised a retry here would only
 * stack on top of the adapter's own.
 */
export class EnrichmentProviderError extends Error {
  constructor(input: { cause?: unknown } = {}) {
    super("enrichment_provider_error", { cause: input.cause });
    this.name = "EnrichmentProviderError";
  }
}
