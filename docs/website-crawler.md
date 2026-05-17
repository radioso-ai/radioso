# Website Crawler Provider

Radioso includes an OSS website crawler provider port and a bundled `radioso-crawler` provider. The provider fetches website pages and publishes them through the normal document ingestion pipeline.

Application composition can still register a different crawler provider. If crawler support is disabled or no provider is available in a custom build, `POST /api/v1/document/crawl` returns an error instead of enqueueing a job.

## API

```text
POST /api/v1/document/crawl
```

The request body is:

```json
{
  "url": "https://example.com/docs",
  "limit": 10,
  "includeUrlPatterns": ["/docs/"],
  "excludeUrlPatterns": ["/tag/", "/search"],
  "preserveContentLinks": true
}
```

Only `url` is required. `limit` is optional. When omitted the backend uses the configured maximum.

The policy fields are optional:

| Field | Notes |
|-------|-------|
| `includeUrlPatterns` | URL substrings to allow. Empty or omitted means no extra allow filter. |
| `excludeUrlPatterns` | URL substrings to deny. Deny patterns win over allow patterns. |
| `preserveContentLinks` | Defaults to `true`. When `false`, content links are rendered as plain text. Share, tracking, and social links are still dropped. |

Pattern matching is case-insensitive substring matching, not regex matching. It is intended for simple path or domain fragments that an operator can understand.

Environment variables:

```bash
WEBSITE_CRAWLER_DEFAULT_LIMIT=1000
WEBSITE_CRAWLER_MAX_LIMIT=1000
WEBSITE_CRAWLER_USER_AGENT=RadiosoCrawler/1.0
```

Pages whose content exceeds 500,000 characters are skipped during ingestion with a skip reason recorded in the crawl job result.

Cookie-session requests select the workspace with `x-workspace-id`. Bearer-token requests use the workspace already bound to the workspace API token and authorize through the crawler's document-management permission. Public chat and website embed launch credentials are not accepted as crawler bearer tokens.

Accepted pages are published as documents with stable external document IDs and a workspace-local website source. Repeated crawls of the same normalized URL reuse that source, so recrawl logic can find the related documents through `sourceId`. Chunking, embeddings, retrieval, and citations remain owned by the standard document worker.

The bundled `radioso-crawler` provider seeds its crawl from the requested URL and from same-origin sitemaps listed in `robots.txt`. It still applies the request `limit`, same-origin scope checks, duplicate removal, and asset filtering before fetching pages. If URL allow patterns are configured and the requested seed URL does not match them, the crawler may fetch that seed page for link discovery, but marks it discovery-only so it is not published as a document.

The bundled crawler uses structurally link-dense pages and low-quality pages for discovery, but does not publish them as documents by default. It also drops share, tracking, and social links from extracted content, keeps source links by default, and records a normalized content hash so duplicate extracted content can be skipped within a crawl run.

By default, outbound crawler requests identify as `RadiosoCrawler/1.0`. Self-hosted operators can set `WEBSITE_CRAWLER_USER_AGENT` to a deployment-specific value, such as `ExampleDocsCrawler/1.0 (+https://example.com/crawler)`. Use this when a site needs to allowlist the crawler or route support requests to the right owner.

Radioso does not rotate user agents or proxies to bypass blocks. If a page returns `401`, `403`, or `429`, the crawler records that page as failed instead of ingesting the block page as content. For `429` responses, `Retry-After` is preserved in the failure message when the site sends it.

### When a site blocks the crawler

Some websites use Cloudflare, other web application firewalls, login gates, or bot-detection rules that block automated fetches. In that case the crawl job will usually show failed pages with reasons such as `403`, `401`, `429`, `Blocked by robots.txt`, or a network error.

Radioso does not try to bypass those controls. It does not solve CAPTCHA challenges, rotate proxies, spoof browsers, or keep retrying with different identities. The site owner needs to allow the crawler or provide content through another path.

In practice, use one of these options:

1. Ask the site owner to allowlist the crawler's user agent and source IP range, if the deployment has stable egress IPs.
2. Set `WEBSITE_CRAWLER_USER_AGENT` to an identifiable value with a contact URL or email, such as `ExampleDocsCrawler/1.0 (+https://example.com/crawler)`, then ask the site owner to allow that user agent.
3. If the site is behind Cloudflare or another WAF that challenges all automated traffic, create a WAF rule that skips the challenge for the crawler identity or IP range.
4. If the content requires authentication, export the pages or upload the source documents directly. The bundled crawler does not crawl authenticated browser sessions.
5. Reduce the crawl scope with `includeUrlPatterns` and `excludeUrlPatterns` so the site does not see a broad scan. This can help with rate limits, but it will not bypass an explicit block.

After changing the site's allow rules, re-run the crawl. If the job has both accepted and failed pages, inspect `failedPageCount` and `failures` in `GET /api/v1/document/crawl/jobs` to confirm which URLs still need attention.

### Document and source metadata

Per-document metadata is intentionally narrow:

| Field | Notes |
|-------|-------|
| `sourceUrl` | Always present. The page URL the crawler fetched. |
| `canonicalUrl` | Always present. Equals `sourceUrl` when the page has no separate canonical, so consumers can rely on the key. |
| `httpStatus`, `etag`, `lastModified` | Optional. Pulled from the provider via a fixed allow-list and only when truthy. Useful for incremental re-crawl decisions. |
| `pageType`, `qualityScore`, `skipReason`, `extractedContainer`, `normalizedContentHash` | Optional crawler diagnostics. These help explain why a page was accepted or skipped. |

Provider-supplied metadata fields outside the allow-list are dropped — including any attempt to spoof `sourceUrl`, `websiteBaseUrl`, or to smuggle secrets.

Run-level and origin-level fields live on `document_sources.metadata` (one row per workspace + crawl URL), not on every document:

| Field | Notes |
|-------|-------|
| `requestedUrl` | The normalized base URL the workspace asked to crawl. |
| `provider` | The crawler provider name (e.g. `radioso-crawler`). |

The `documents.list` API joins `document_sources` so each `DocumentSummary` exposes `source.kind = "website"` and `source.externalId = <baseUrl>` for UI grouping or filtering.

### Listing recent crawl jobs

```text
GET /api/v1/document/crawl/jobs
```

Returns recent crawl jobs for the current workspace. The dashboard uses this endpoint to show queued, running, paused, completed, and failed crawls without polling each document.

Query parameters are all optional:

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `status` | `queued` \| `processing` \| `paused` \| `completed` \| `failed` | unset (any) | Filter to a single status. |
| `sinceMinutes` | integer 1-1440 | `30` | Only return jobs updated in this window. Ignored when `sourceId` is set or when filtering `status=paused`. |
| `limit` | integer 1-200 | `50` | Maximum number of jobs to return. |
| `sourceId` | UUID | unset | Filter to jobs linked to a specific document source. |

Response shape:

```json
{
  "jobs": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "requestedUrl": "https://example.com/docs",
      "status": "completed",
      "limit": 10,
      "sourceId": "22222222-2222-4222-8222-222222222222",
      "documentCount": 7,
      "skippedPageCount": 2,
      "failedPageCount": 1,
      "failures": [
        {
          "sourceUrl": "https://example.com/docs/large-dump",
          "reason": "Page content exceeds maximum length (500,000 characters)"
        }
      ],
      "lastError": null,
      "createdAt": "2026-05-11T10:00:00.000Z",
      "updatedAt": "2026-05-11T10:05:00.000Z",
      "completedAt": "2026-05-11T10:05:00.000Z"
    }
  ]
}
```

`documentCount` is derived from the worker result (`accepted` pages). It is `null` for jobs that have not completed yet. `skippedPageCount` counts pages that were intentionally not published, such as listing pages, duplicate content, empty content, or oversized pages. `failedPageCount` counts pages that could not be fetched, validated, or published. `failures` contains the URL and reason for skipped or failed pages. `lastError` is populated for failed jobs and is `null` otherwise.

### Deleting a finished crawl job

```text
DELETE /api/v1/document/crawl/jobs/{jobId}
```

Removes the row from `website_crawl_jobs`. The crawled documents are not deleted — they live in the documents table and can be removed individually through the standard document API.

The endpoint only accepts terminal jobs:

- `204` — job was deleted (status was `completed` or `failed`).
- `404` — job does not exist or belongs to another workspace.
- `409` — job is still `queued` or `processing` and cannot be removed; let it finish first.

The dashboard banner uses this endpoint when the user clicks the dismiss button on a completed or failed row. For in-flight jobs the dismiss button only hides the row in local state, since the job is genuinely still running.

### Listing documents for a source

```text
GET /api/v1/document/sources/{sourceId}/documents
```

Returns a paginated list of documents belonging to a source. Supports the same `limit`, `offset`, and `cursor` query parameters as `GET /api/v1/document/`. The synthetic "Manually added documents" source ID (`00000000-0000-0000-0000-000000000001`) returns documents with no source.

### Re-crawling a website source

```text
POST /api/v1/document/sources/{sourceId}/recrawl
```

Enqueues a new crawl job using the URL and limit stored in the source's `config`. Only works for sources with `kind: "website"`. Returns the same `202` response as `POST /api/v1/document/crawl`.

Duplicate pages are handled by the existing `externalDocumentId` upsert — unchanged pages update the existing document rather than creating a new one.

### Pausing and resuming a website source crawl

```text
POST /api/v1/document/sources/{sourceId}/pause-crawl
POST /api/v1/document/sources/{sourceId}/resume-crawl
```

Pause and resume only apply to website sources. Pausing marks queued or processing crawl jobs as `paused`. If a worker is processing the job, the paused row keeps its claim until the worker observes the status change, aborts the active crawl, releases the claim, and keeps the checkpoint state.

Resume marks unclaimed paused jobs as `queued`. The worker loads the saved checkpoint and continues from the discovered and pending URLs for the same job and policy. URLs already processed in that job are not republished.

Changing crawler policy is a new crawl. Resume continues the same paused job and does not create a new source configuration version.

### Deleting a source

```text
DELETE /api/v1/document/sources/{sourceId}
```

Deletes the source row, all documents linked to it, and any uploaded-file storage objects for those documents. Queued or in-progress crawl jobs for the source are cancelled first to prevent the worker from recreating the source after deletion.

- `204` — source and documents deleted.
- `400` — the synthetic "Manually added documents" source cannot be deleted.
- `404` — source does not exist or belongs to another workspace.

## Provider Contract

A provider receives a normalized crawl request and returns pages:

```ts
interface WebsiteCrawlerProvider {
  name: string;
  crawl(request: {
    url: string;
    limit: number;
    signal?: AbortSignal;
    policy?: {
      includeUrlPatterns: string[];
      excludeUrlPatterns: string[];
      preserveContentLinks: boolean;
    };
    checkpoint?: {
      discoveredUrls: string[];
      queuedUrls: string[];
      processingUrls: string[];
      processedCanonicalUrls: string[];
      processedContentHashes?: string[];
      accepted: number;
      skipped: number;
      failed: number;
      lastProcessedAt: string | null;
    };
    onCheckpointEvent?: (event: WebsiteCrawlCheckpointEvent) => Promise<void>;
  }): Promise<WebsiteCrawlResult>;
  crawlStream?(
    request: {
      url: string;
      limit: number;
      signal?: AbortSignal;
      policy?: WebsiteCrawlPolicy;
      checkpoint?: WebsiteCrawlCheckpoint;
      onCheckpointEvent?: (event: WebsiteCrawlCheckpointEvent) => Promise<void>;
    },
    onPage: (page: WebsiteCrawlPage) => Promise<void>,
  ): Promise<Omit<WebsiteCrawlResult, "pages">>;
}
```

When `crawlStream` is implemented, the service calls it instead of `crawl`, ingesting each page as soon as the crawler discovers it rather than waiting for the entire crawl to finish. The batch `crawl` method is used as a fallback for providers that do not support streaming.

Radioso validates returned page URLs, removes duplicate canonical URLs, skips empty content and oversized pages, redacts sensitive provider details, and rejects crawl targets that resolve to localhost or private network addresses.

## Deployment topology

Website crawl jobs run in a dedicated worker process, separate from the document processing worker that handles chunking and embeddings. A long crawl cannot starve the embedding workload, and each side can be scaled independently.

In practice this is two long-running processes per environment:

- `start:worker` (or `start:worker-server`) — runs the document processing worker and consumer. Receives Cloud Tasks pushes at `/internal/tasks/document-processing` when `WORKER_DISPATCH_DRIVER=cloud-tasks`.
- `start:crawler-worker` (or `start:crawler-worker-server`) — runs the website crawl worker and consumer. Receives Cloud Tasks pushes at `/internal/tasks/website-crawl` when `WORKER_DISPATCH_DRIVER=cloud-tasks`.

Database polling stays active in both processes as a fallback, so an outage of the queue dispatcher does not lose work.

### Local docker-compose

Both `docker-compose.yml` and `docker-compose.dev.yml` define a `backend-crawler-worker` service alongside the existing `backend-worker`. Bring the full stack up with `docker compose up`; bring just the crawler back after a code change with `docker compose up -d --force-recreate backend-crawler-worker`.

### Cloud Run + Cloud Tasks

The Terraform configuration provisions two Cloud Run services:

- `radioso-<env>-worker` runs `start:worker-server` and receives the document Cloud Tasks queue.
- `radioso-<env>-crawler-worker` runs `start:crawler-worker-server` and receives the website crawl Cloud Tasks queue.

The dispatcher reads `WORKER_TASKS_CRAWL_SERVICE_URL` to know where website crawl Cloud Tasks pushes should land. When unset it falls back to `WORKER_TASKS_SERVICE_URL`, so a single-worker deployment still works. Terraform discovers the crawler worker URL automatically by referencing `google_cloud_run_v2_service.crawler_worker.uri` from the backend and document worker — no override variable is needed. The document worker URL still needs `worker_tasks_service_url_override` on the second apply because the document worker self-references its own URI for retry dispatch.

Scaling defaults are independent: `worker_min_instances` / `worker_max_instances` for the document worker, `crawler_worker_min_instances` / `crawler_worker_max_instances` for the crawler. The document worker can use `worker_min_instances = 0` in Cloud Tasks driven environments to scale to zero when idle. Set it above zero only when the document queue needs a continuously warm polling fallback. The crawler worker keeps its own minimum instance setting because website crawl recovery is managed separately.

### Rollout ordering

When upgrading from a single combined worker to the split topology (this PR), the order matters:

1. Deploy the new `crawler_worker` Cloud Run service (or `backend-crawler-worker` container).
2. Apply Terraform / restart the backend so newly enqueued crawl Cloud Tasks land on the new worker URL via `WORKER_TASKS_CRAWL_SERVICE_URL`.
3. Roll the document worker last.

In-flight Cloud Tasks pushes that were enqueued against the old combined worker URL will keep arriving at `/internal/tasks/website-crawl` on the **document worker** for a few minutes. The document worker responds `410 Gone` to that path so Cloud Tasks stops retrying immediately. The polling fallback in the new crawler worker then reclaims those jobs on the next 5-second tick. A delay of one polling interval is the worst case; no work is lost. The 410 stub is a one-release compatibility shim and can be removed after the next release.

## Disabling the crawler

Set `WEBSITE_CRAWLER_ENABLED=false` on the backend (and on the crawler worker, if you keep it deployed). With the flag off:

- `POST /api/v1/document/crawl` and `GET /api/v1/document/crawl/jobs` return `404`. Existing crawl jobs in the database are untouched.
- The dashboard hides the "Crawl Website" button, skips polling for crawl jobs, and never renders the status banner. The signal travels through `GET /api/v1/workspace/summary` as `websiteCrawlerEnabled: false`.
- The crawler worker entrypoints (`start:crawler-worker` and `start:crawler-worker-server`) log a single message and exit cleanly so the container can be removed from compose, k8s, or Cloud Run.

The flag is global to the deployment; it is exposed per-workspace in the summary because that is where the dashboard needs it. A self-hosted operator who does not want crawler functionality only needs to set this one variable — the document processing pipeline is unaffected.
