import { canonicalContentHash } from "../../../../shared/domain/canonicalContentHash.js";
import type { DocumentEnrichmentRequest } from "./enrichmentGateway.js";

/**
 * The last usable reply a document's enrichment got, with the fingerprint of
 * the request that produced it. A later run that would send the same request
 * applies this reply instead of asking again; only what the model saw decides
 * that, never which revision is asking.
 */
export interface StoredEnrichmentReply {
  requestFingerprint: string;
  /** The model that answered, recorded on the provenance of every run that applies the reply. */
  model: string;
  /** The reply as the gateway returned it, read again in full by every run that applies it. */
  output: unknown;
}

interface EnrichedDocumentRef {
  workspaceId: string;
  documentId: string;
}

/** Writes name the revision the run read, so a superseded run cannot touch a newer revision's reply. */
interface EnrichedRevisionRef extends EnrichedDocumentRef {
  revision: number;
}

/**
 * Where a document's last usable reply is kept. It saves cost, never
 * correctness: a reply that cannot be found or read is asked for again.
 */
export interface EnrichmentReplyStore {
  find(document: EnrichedDocumentRef): Promise<StoredEnrichmentReply | null>;
  save(document: EnrichedRevisionRef, reply: StoredEnrichmentReply): Promise<void>;
  clear(document: EnrichedRevisionRef): Promise<void>;
}

export const noEnrichmentReplyStore: EnrichmentReplyStore = {
  async find() {
    return null;
  },
  async save() {},
  async clear() {},
};

// Bumped when what a stored reply means changes, so replies stored before
// stop matching.
const FINGERPRINT_VERSION = 1;

/**
 * Everything the model is shown — the system prompt with the rendered catalog,
 * the document as the model reads it, the schema its reply must match — and
 * the gateway's request settings, which shape the reply as much. Document
 * metadata is not among it, so a metadata edit reuses the reply and only the
 * deterministic steps that apply it see the change. The model is not among it
 * either: a reply stays a reading of the same request when the deployment's
 * model changes, and re-asking would bill every unchanged document again.
 */
export const fingerprintEnrichmentRequest = (
  request: Pick<DocumentEnrichmentRequest, "prompt" | "documentRepresentation" | "outputSchema">,
  requestProfile: string,
): string =>
  canonicalContentHash({
    version: FINGERPRINT_VERSION,
    requestProfile,
    prompt: request.prompt,
    documentRepresentation: request.documentRepresentation,
    outputSchema: request.outputSchema,
  });
