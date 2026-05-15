export interface WebsiteCrawlRequest {
  url: string;
  limit: number;
  signal?: AbortSignal;
}

export interface WebsiteCrawlPage {
  sourceUrl: string;
  canonicalUrl?: string | null;
  title?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface WebsiteCrawlResult {
  provider: string;
  runId?: string | null;
  status?: string | null;
  pages: WebsiteCrawlPage[];
  invalidPages?: number;
}

export interface WebsiteCrawlerProvider {
  name: string;
  crawl(request: WebsiteCrawlRequest): Promise<WebsiteCrawlResult>;
  crawlStream?(request: WebsiteCrawlRequest, onPage: (page: WebsiteCrawlPage) => Promise<void>): Promise<Omit<WebsiteCrawlResult, "pages">>;
}
