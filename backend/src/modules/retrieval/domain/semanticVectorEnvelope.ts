import { createHash } from "node:crypto";

import type { EmbeddingSpaceRef } from "../../embeddingProfiles/contracts/embeddingConsumers.js";

/**
 * A content-free record of a semantic query vector that retrieval actually
 * searched. Consumers can correlate the stable intent slot and hash without
 * depending on retrieval branches or receiving the semantic text itself.
 */
export interface SemanticVectorEnvelope {
  readonly intentId: string;
  readonly semanticTextHash: string;
  readonly vector: number[];
  readonly space: EmbeddingSpaceRef;
}

export const createSemanticVectorEnvelope = (input: {
  intentId: string;
  semanticText: string;
  vector: readonly number[];
  space: EmbeddingSpaceRef;
}): SemanticVectorEnvelope => ({
  intentId: input.intentId,
  semanticTextHash: createHash("sha256").update(input.semanticText, "utf8").digest("hex"),
  vector: [...input.vector],
  space: input.space,
});
