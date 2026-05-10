# Website Crawler Provider

Radioso includes an OSS website crawler provider port. The port lets an application module supply crawler results that Radioso can publish through the normal document ingestion pipeline.

The core backend does not include a concrete crawler provider. In practice, `POST /api/v1/document/crawl` returns `503 service_unavailable` until a provider is registered through application composition.

## API

```text
POST /api/v1/document/crawl
```

The request body is:

```json
{
  "url": "https://example.com/docs",
  "limit": 10
}
```

`limit` is optional. The backend caps it with:

```bash
WEBSITE_CRAWLER_DEFAULT_LIMIT=10
WEBSITE_CRAWLER_MAX_LIMIT=100
```

Cookie-session requests select the workspace with `x-workspace-id`. Bearer-token requests use the workspace already bound to the API token.

Accepted pages are published as documents with stable external document IDs and a workspace-local website source. Repeated crawls of the same normalized URL reuse that source, so recrawl logic can find the related documents through `sourceId`. Chunking, embeddings, retrieval, and citations remain owned by the standard document worker.

## Provider Contract

A provider receives a normalized crawl request and returns pages:

```ts
interface WebsiteCrawlerProvider {
  name: string;
  crawl(request: {
    url: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<{
    provider: string;
    runId?: string | null;
    status?: string | null;
    pages: Array<{
      sourceUrl: string;
      canonicalUrl?: string | null;
      title?: string | null;
      content: string;
      metadata?: Record<string, unknown>;
    }>;
  }>;
}
```

Radioso validates returned page URLs, removes duplicate canonical URLs, skips empty content, redacts sensitive provider details, and rejects crawl targets that resolve to localhost or private network addresses.
