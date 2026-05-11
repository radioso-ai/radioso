export type DocumentPublisherResult = {
  documentId: string;
  status: "received" | "processed" | "pending";
};

export type DocumentPublicationMetadata = {
  sourceUrl: string;
  frontierUrl: string;
  canonicalUrl: string;
  canonicalUrlKey: string;
  contentHash: string | null;
  crawlRunId: string;
  sourceId: string;
  sourceScopeKey: string;
  pageStatus: "success" | "unchanged" | "failed" | "removed";
  httpStatus: number | null;
  etag: string | null;
  lastModified: string | null;
  transportUsed: "http" | "browser" | null;
  browserFallbackReason: "http_error" | "incomplete_http" | "low_quality" | null;
  httpQualityScore: number | null;
  lastFetchedAt: string;
} & Record<string, unknown>;

export type DocumentPublicationEnvelope = {
  externalId: string;
  title: string;
  content: string;
  metadata: DocumentPublicationMetadata;
};

export type DocumentPublisher = {
  upsert: (
    document: DocumentPublicationEnvelope
  ) => Promise<DocumentPublisherResult>;
  remove: (input: { externalId: string }) => Promise<void>;
};
