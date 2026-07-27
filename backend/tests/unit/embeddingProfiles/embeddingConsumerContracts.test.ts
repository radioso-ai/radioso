import { describe, expectTypeOf, it } from "vitest";

import type {
  ClusteringEmbeddingPort,
  DocumentEmbeddingPort,
  EmbeddingConsumerResult,
  QueryEmbeddingPort,
} from "../../../src/modules/embeddingProfiles/public.js";

describe("embedding consumer contracts", () => {
  it("keep provider, model, dimensions, and purpose out of consumer requests", () => {
    type QueryRequest = Parameters<QueryEmbeddingPort["embedQueries"]>[0];
    type DocumentRequest = Parameters<
      DocumentEmbeddingPort["embedDocumentChunks"]
    >[0];
    type ClusteringRequest = Parameters<
      ClusteringEmbeddingPort["embedForClustering"]
    >[0];

    expectTypeOf<QueryRequest>().not.toHaveProperty("provider");
    expectTypeOf<QueryRequest>().not.toHaveProperty("model");
    expectTypeOf<QueryRequest>().not.toHaveProperty("dimensions");
    expectTypeOf<QueryRequest>().not.toHaveProperty("purpose");
    expectTypeOf<DocumentRequest>().not.toHaveProperty("provider");
    expectTypeOf<DocumentRequest>().not.toHaveProperty("model");
    expectTypeOf<DocumentRequest>().not.toHaveProperty("dimensions");
    expectTypeOf<DocumentRequest>().not.toHaveProperty("purpose");
    expectTypeOf<ClusteringRequest>().not.toHaveProperty("provider");
    expectTypeOf<ClusteringRequest>().not.toHaveProperty("model");
    expectTypeOf<ClusteringRequest>().not.toHaveProperty("dimensions");
    expectTypeOf<ClusteringRequest>().not.toHaveProperty("purpose");
    expectTypeOf<
      Awaited<ReturnType<QueryEmbeddingPort["embedQueries"]>>
    >().toEqualTypeOf<EmbeddingConsumerResult>();
  });
});

