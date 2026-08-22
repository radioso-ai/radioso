import type { WebsiteCrawlCheckpoint, WebsiteCrawlPolicy } from "./policy.js";

export interface WebsiteCrawlRequest {
  url: string;
  limit: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  policy?: WebsiteCrawlPolicy;
  checkpoint?: WebsiteCrawlCheckpoint;
  onCheckpointEvent?: (event: WebsiteCrawlCheckpointEvent) => Promise<void>;
}

export type WebsiteCrawlCheckpointEvent =
  | { type: "discovered"; url: string; canonicalUrl: string | null }
  | { type: "processing"; url: string; canonicalUrl: string | null }
  | { type: "processed"; url: string; canonicalUrl: string | null };

export interface WebsiteCrawlPage {
  sourceUrl: string;
  canonicalUrl?: string | null;
  title?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
}

export type WebsiteCrawlExecutionOutcome = "completed" | "yielded";

export interface WebsiteCrawlResult {
  provider: string;
  runId?: string | null;
  status?: string | null;
  outcome?: WebsiteCrawlExecutionOutcome;
  pages: WebsiteCrawlPage[];
  invalidPages?: number;
  skipped?: number;
}

export interface WebsiteCrawlerProvider {
  name: string;
  crawl(request: WebsiteCrawlRequest): Promise<WebsiteCrawlResult>;
  crawlStream?(request: WebsiteCrawlRequest, onPage: (page: WebsiteCrawlPage) => Promise<void>): Promise<Omit<WebsiteCrawlResult, "pages">>;
}
