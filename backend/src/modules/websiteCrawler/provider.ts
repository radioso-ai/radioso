import type { DocumentImageCandidate } from "../documents/contracts/index.js";
import type { WebsiteCrawlCheckpoint, WebsiteCrawlPolicy } from "./policy.js";

export interface WebsiteCrawlRequest {
  url: string;
  /** The pages this slice may fetch: what is left of the crawl's limit after earlier slices. */
  limit: number;
  /** The whole crawl's page limit. The provider sizes link discovery from it, since earlier slices' links count. */
  totalLimit?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  policy?: WebsiteCrawlPolicy;
  checkpoint?: WebsiteCrawlCheckpoint;
  onCheckpointEvent?: (event: WebsiteCrawlCheckpointEvent) => Promise<void>;
}

export type WebsiteCrawlCheckpointEvent =
  | { type: "discovered"; url: string; canonicalUrl: string | null }
  | { type: "processing"; url: string; canonicalUrl: string | null }
  | { type: "processed"; url: string; canonicalUrl: string | null }
  /** A link the crawl found but did not queue, because it reached a limit. */
  | { type: "dropped"; url: string; canonicalUrl: string | null }
  /** The crawl could not read the site's robots.txt or a sitemap it lists, so it may not know every page. */
  | { type: "sitemap_unread" };

export interface WebsiteCrawlPage {
  sourceUrl: string;
  canonicalUrl?: string | null;
  title?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
  /** The page's metadata picture and the images in its main content; an inline image's offset indexes `content`. */
  images?: DocumentImageCandidate[];
}

export type WebsiteCrawlExecutionOutcome = "completed" | "yielded";

export interface WebsiteCrawlResult {
  provider: string;
  runId?: string | null;
  status?: string | null;
  outcome?: WebsiteCrawlExecutionOutcome;
  /**
   * True only when the crawl stopped because nothing was left to fetch: not its page limit, a
   * discovery limit, its time slice, or an abort. Missing means the provider cannot tell, which
   * counts as not exhausted.
   */
  frontierExhausted?: boolean;
  pages: WebsiteCrawlPage[];
  invalidPages?: number;
  skipped?: number;
}

export interface WebsiteCrawlerProvider {
  name: string;
  crawl(request: WebsiteCrawlRequest): Promise<WebsiteCrawlResult>;
  crawlStream?(request: WebsiteCrawlRequest, onPage: (page: WebsiteCrawlPage) => Promise<void>): Promise<Omit<WebsiteCrawlResult, "pages">>;
}
