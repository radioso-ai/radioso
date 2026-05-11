import type { DocumentPublicationEnvelope } from "../types.js";

export type CrawlerExecutionMode = "attached" | "radioso-crawler";

export type CrawlerRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "recovering";

export type CrawlerPageStatus = "success" | "unchanged" | "failed" | "removed";

export type NormalizedCrawlerPage = {
  sourceId: string;
  runId: string;
  frontierUrl: string;
  fetchedUrl: string;
  canonicalUrl: string;
  canonicalUrlKey: string;
  title: string | null;
  content: string;
  contentHash: string | null;
  status: CrawlerPageStatus;
  httpStatus: number | null;
  etag?: string | null;
  lastModified?: string | null;
  transportUsed?: "http" | "browser";
  browserFallbackReason?: "http_error" | "incomplete_http" | "low_quality" | null;
  httpQualityScore?: number | null;
  error?: string | null;
  document?: DocumentPublicationEnvelope;
};
