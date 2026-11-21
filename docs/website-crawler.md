---
title: "Website Crawler Provider"
description: "API and provider contract for website ingestion including crawl policy, job management, deployment topology, and disabling."
last_updated: 2026-11-21
---

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

Cookie-session requests select the workspace with `x-workspace-id`. Crawler configuration and document-management operations accept either a signed-in dashboard session or an eligible personal or service API credential. Provider-secret settings remain session-only. Public chat, website embed, role-free agent channel, and MCP session credentials are not accepted as crawler credentials.

Accepted pages are published as documents with stable external document IDs and a workspace-local website source. Repeated crawls of the same normalized URL reuse that source, so recrawl logic can find the related documents through `sourceId`. Chunking, embeddings, metadata extraction, retrieval, and citations remain owned by the standard document worker.

Website sources can also carry a metadata extraction override. The override is `inherit`, `on`, or `off`; `inherit` uses the workspace ingestion setting. When extraction is on, the standard document worker classifies each processed page and may attach date tags to event-shaped chunks. A new crawl of the same URL writes its own `limit` and `policy` to the source and leaves the override and the source's `documentMetadata` as the operator set them.

The bundled `radioso-crawler` provider seeds its crawl from the requested URL and from same-origin sitemaps listed in `robots.txt`. It still applies the request `limit`, same-origin scope checks, duplicate removal, and asset filtering before fetching pages. Before each outbound fetch hop, including redirects, Radioso rejects URLs that resolve to localhost or private network addresses. If URL allow patterns are configured and the requested seed URL does not match them, the crawler may fetch that seed page for link discovery, but marks it discovery-only so it is not published as a document.

The bundled crawler uses structurally link-dense pages and low-quality pages for discovery, but does not publish them as documents by default. A page counts as low-quality when its extracted text is dominated by links, unrendered template markup, or repeated words; a short page with clean extraction, such as a contact page or a glossary entry, is published. The crawl job's `failures` list records the skip reason for every page it held back. It also drops share, tracking, and social links from extracted content, keeps source links by default, and records a normalized content hash so duplicate extracted content can be skipped within a crawl run.

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

The source response also exposes `documentEnrichmentOverride`, so operators can enable enrichment for an events source without changing unrelated uploads or crawled sites.

### Page pictures

Each page also hands ingestion the pictures it names, by address, never by bytes:

| Picture | Where the crawler finds it | Role |
|---------|----------------------------|------|
| The page's own picture | `og:image` (and its `:url` and `:secure_url` forms), then `twitter:image`, then the JSON-LD `image` of the page's entity or its `primaryImageOfPage` | `primary`, up to 3 distinct addresses |
| Pictures in the content | Each `<img>` the text extraction keeps as main content: its `srcset` source at least 640 pixels wide (else the widest), a lazy loader's `data-src`, or `src`; its `alt`; its `<figure>`'s `<figcaption>`; and its offset in the page text | `inline`, up to 24 |

`data:` addresses, SVG files, and anything that is not absolute http(s) are left out. The offset places the picture in the stored text, so the worker ties it to the chunk it sits in. The documents worker fetches, filters and stores the pictures after the page is processed ([Document processing lifecycle](../docs-portal/content/architecture/document-processing-lifecycle.mdx)); a page whose text did not change still records new pictures on a re-crawl, and a picture the page no longer names is deleted.

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

Returns a paginated list of documents belonging to a source. Supports the same `limit`, `offset`, and `cursor` query parameters as `GET /api/v1/document`. The synthetic "Manually added documents" source ID (`00000000-0000-0000-0000-000000000001`) returns documents with no source.

### Re-crawling a website source

```text
POST /api/v1/document/sources/{sourceId}/recrawl
```

Enqueues a new crawl job using the URL and limit stored in the source's `config`. Only works for sources with `kind: "website"`. Returns the same `202` response as `POST /api/v1/document/crawl`.

A source runs one crawl at a time. When a crawl for the source is already queued or processing, the recrawl, a scheduled recrawl, and a new `POST /api/v1/document/crawl` for the same URL all answer with that crawl's `jobId` and start nothing. A paused crawl does not count: a recrawl next to it starts a new one.

Duplicate pages are handled by the existing `externalDocumentId` upsert — unchanged pages update the existing document rather than creating a new one.

After a complete crawl, the source's pages the crawl did not find are removed. A crawl counts as complete when it finished with no failed pages and stopped below its page limit, however many two-minute slices it took and whether or not it was paused and resumed. It is measured against every page the whole job processed, which the job's checkpoint carries from slice to slice: a page skipped as duplicate content or by the crawl policy counts as found and stays. A checkpoint lists at most 10,000 processed pages, so a crawl whose list reached that size removes nothing. Any other crawl removes nothing.

### Keeping a website source up to date

A website source can recrawl itself with its saved URL, limit, and crawl policy. Each scheduled recrawl does what a manual recrawl does: it skips pages whose content is unchanged, updates changed pages in place, and adds new ones. Choose how often with:

```text
PUT /api/v1/document/sources/{sourceId}/recrawl-cadence
```

```json
{ "recrawlCadence": "weekly" }
```

`recrawlCadence` is `off`, `daily`, or `weekly`. Every source starts at `off`. Turning a cadence on, or changing it, schedules the next recrawl one interval after the source's last crawl, or now when that is already past, plus up to an hour of jitter so sources set together do not all crawl at once. Sending the cadence the source already has keeps the time already scheduled; `off` clears it. The response is the source, as `GET /api/v1/document/sources` lists it.

Every website source in the source list carries four fields about this:

| Field | Meaning |
|-------|---------|
| `recrawlCadence` | The cadence the operator chose. |
| `nextRecrawlAt` | When the next scheduled recrawl is queued, or `null` while the cadence is `off`. |
| `fastestRecrawlCadence` | The fastest cadence the workspace's plan allows: `daily` on self-hosted deployments, and on Radioso Cloud `weekly` on Comet and `daily` on Satellite and Planet. |
| `heldPageCount` | Pages a scheduled recrawl no longer found and held for review. |

Asking for a cadence faster than `fastestRecrawlCadence` answers `403` with code `recrawl_cadence_not_in_plan` and `details.fastestRecrawlCadence`. A workspace that moves to a plan with a slower ceiling keeps its sources' chosen cadence; they recrawl at the plan's fastest.

The `website-recrawl` periodic task queues the crawls. Every 15 minutes it claims the website sources whose next recrawl is due, moves each one interval ahead, and queues a crawl for it. A source that already has a crawl queued, processing, or paused waits for its next time, and so does one whose crawl could not be queued. On a self-hosted deployment the document worker's poll loop runs the task, so a stack started with `./run-dev.sh` or Docker Compose recrawls with no extra settings. On Cloud Run, a Cloud Scheduler job calls `/internal/tasks/periodic-tasks/website-recrawl/run` on the worker task service. Each run logs one line with how many sources were due, queued, skipped because a crawl was active, and failed.

### Pages a scheduled recrawl holds

A scheduled recrawl never removes a large share of a source on its own. When the pages it did not find are more than a fifth of the pages the source had when its job started, it removes none of them and holds them for review instead; the source's `heldPageCount` says how many. A loss that large is more often a moved, broken, or blocking site than a pruned one. A fifth or less is removed as a manual recrawl removes it. A manual recrawl or a new crawl of the same URL removes every page it did not find, held or not, because the operator asked for a fresh copy of the site.

Decide on held pages with:

```text
POST /api/v1/document/sources/{sourceId}/held-pages/remove
POST /api/v1/document/sources/{sourceId}/held-pages/keep
```

Remove deletes the held pages the way a recrawl removes missing pages and answers `{ "sourceId": "...", "removedPageCount": 12 }`. Keep answers `{ "sourceId": "...", "keptPageCount": 12 }`; later scheduled recrawls neither hold nor remove a kept page. A held or kept page that a complete crawl finds again goes back to being an ordinary page. A source with nothing held answers with a count of `0`.

The crawl audit event, `document.website_crawler.crawl`, records `trigger`: `manual` for a crawl the operator, the API, or Ray started, `scheduled` for one the sweep queued. A hold records `document.website_crawler.missing_pages_held` with the source, how many pages are held, and how many pages the source had. The operator's decisions record `document.website_crawler.held_pages_removed` and `document.website_crawler.held_pages_kept` with the page count. A scheduled recrawl that stops on the workspace's ingestion quota fails like any other crawl: the job shows the failure and the source's last sync is `failure`.

### Reprocessing a source

```text
POST /api/v1/document/sources/{sourceId}/reprocess
```

Requeues eligible documents that already belong to the source. This does not crawl the site again. Use it after changing chunking settings or a source metadata extraction override when the existing documents should be rebuilt.

The optional body can force metadata extraction for this run:

```json
{
  "documentEnrichmentOverride": "on"
}
```

Values are `on` and `off`. The response reports queued and skipped document counts.

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
    maxDurationMs?: number;
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
      maxDurationMs?: number;
      signal?: AbortSignal;
      policy?: WebsiteCrawlPolicy;
      checkpoint?: WebsiteCrawlCheckpoint;
      onCheckpointEvent?: (event: WebsiteCrawlCheckpointEvent) => Promise<void>;
    },
    onPage: (page: WebsiteCrawlPage) => Promise<void>,
  ): Promise<Omit<WebsiteCrawlResult, "pages">>;
}
```

A `WebsiteCrawlPage` carries `sourceUrl`, `canonicalUrl`, `title`, `content`, `metadata`, and `images`: the page's pictures as document image candidates (`sourceUrl`, `role`, `alt`, `caption`, and for an inline picture `textOffset`, an offset into `content`). Ingestion validates every candidate and drops one that does not read as one.

When `crawlStream` is implemented, the service calls it instead of `crawl`, ingesting each page as soon as the crawler discovers it rather than waiting for the entire crawl to finish. The batch `crawl` method is used as a fallback for providers that do not support streaming.

`maxDurationMs` bounds one execution slice. A streaming provider returns `outcome: "yielded"` only when its own slice-abort signal ends the crawl, and returns `outcome: "completed"` when its frontier is exhausted. Callback, ingestion, and checkpoint failures remain terminal errors even if they arrive near the slice boundary. A yielded result is not terminal: Radioso keeps the checkpoint, queues the same job for another delivery, and leaves source sync state unchanged until the crawl completes.

Radioso validates returned page URLs, removes duplicate canonical URLs, skips empty content and oversized pages, redacts sensitive provider details, and rejects crawl targets that resolve to localhost or private network addresses. The bundled provider applies that public-network policy before fetching each page, `robots.txt`, same-origin sitemap, and redirect target.

## Deployment topology

Website crawl jobs run in a dedicated worker process, separate from the document processing worker that handles chunking and embeddings. Crawl and embedding capacity can be scaled independently.

In practice this is two long-running processes per environment:

- `start:worker` (or `start:worker-server`) — runs the document processing worker and consumer. Receives Cloud Tasks pushes at `/internal/tasks/document-processing` when `WORKER_DISPATCH_DRIVER=cloud-tasks`.
- `start:crawler-worker` (or `start:crawler-worker-server`) — runs the website crawl worker and consumer. Receives Cloud Tasks pushes at `/internal/tasks/website-crawl` when `WORKER_DISPATCH_DRIVER=cloud-tasks`.

The long-running commands poll the database. The `*-server` commands process explicit queue deliveries and rely on scheduled recovery for a missed dispatch.

### Local docker-compose

Both `docker-compose.yml` and `docker-compose.dev.yml` define a `backend-crawler-worker` service alongside the existing `backend-worker`. Bring the full stack up with `docker compose up`; bring just the crawler back after a code change with `docker compose up -d --force-recreate backend-crawler-worker`.

### Cloud Run + Cloud Tasks

The Terraform configuration provisions two Cloud Run services:

- `radioso-<env>-worker` runs `start:worker-server` and receives the document Cloud Tasks queue.
- `radioso-<env>-crawler-worker` runs `start:crawler-worker-server` and receives the website crawl Cloud Tasks queue.

Website crawl Cloud Tasks pushes land at `WORKER_TASKS_CRAWL_SERVICE_URL`, which every service needs when `WORKER_DISPATCH_DRIVER=cloud-tasks`. That includes the crawler worker, because it queues the continuation task for each slice it finishes. The backend and document worker read the URL from `google_cloud_run_v2_service.crawler_worker.uri`. The crawler worker gets Cloud Run's deterministic URL, `https://radioso-<env>-crawler-worker-<project-number>.<region>.run.app`, which Terraform builds from the service name, project number, and region, since a service can't reference its own `uri`. Neither needs an override variable. The document worker URL still needs `worker_tasks_service_url_override` on the second apply because the document worker self-references its own URI for retry dispatch.

Every `/internal/tasks/*` request also carries `X-Radioso-Worker-Token`. Set the same `WORKER_TASK_AUTH_TOKEN` value on the backend, document worker, and crawler worker; the included Terraform manages and injects it for Cloud Run and adds it to Cloud Scheduler recovery requests. Google OIDC remains enabled as the infrastructure-level check. A reverse proxy in front of a self-hosted task server must forward the custom header, and the token must be at least 32 characters.

Scaling defaults are independent: `worker_min_instances` / `worker_max_instances` for the document worker, `crawler_worker_min_instances` / `crawler_worker_max_instances` for the crawler. In Cloud Tasks driven environments, both worker services use `min_instances = 0` and request-based CPU so they can scale to zero when idle. The task-server runtimes process explicit Cloud Tasks deliveries by job ID. They do not start the continuous database polling loops.

The crawler worker runs a job in two-minute slices, below Cloud Scheduler's three-minute request deadline and Cloud Run's five-minute request timeout. At the end of a slice it saves the frontier checkpoint, atomically returns the same job to `queued`, creates a continuation task, and finishes the current request. Pages interrupted by the slice boundary stay pending for the next delivery instead of being counted as failures. If a crawl shows `Queued` again after its first slice and stays there, check the document worker's request logs for `410` responses on `/internal/tasks/website-crawl`: the continuation went to the document worker, which means the crawler worker's `WORKER_TASKS_CRAWL_SERVICE_URL` points at the wrong service.

Terraform also provisions Cloud Scheduler recovery jobs for both workers. Each crawler recovery request reserves 120 seconds for a crawl slice inside a 150-second request budget, so it starts another queued job only when the first finishes within the initial 30-second window. When a recovered crawl yields, the request stops after dispatching its continuation rather than reclaiming the same job again. Document recovery defaults to hourly (`document_worker_recovery_schedule = "0 * * * *"`). Crawler recovery defaults to daily (`crawler_worker_recovery_schedule = "0 3 * * *"`) because normal crawls are delivered through Cloud Tasks and the crawler is usually idle. This keeps missed-dispatch recovery available without using a frequent recovery request as a keepalive.

### Rollout ordering

When upgrading from a single combined worker to the split topology, the order matters:

1. Deploy the new `crawler_worker` Cloud Run service (or `backend-crawler-worker` container).
2. Apply Terraform / restart the backend so newly enqueued crawl Cloud Tasks land on the new worker URL via `WORKER_TASKS_CRAWL_SERVICE_URL`.
3. Roll the document worker last.

When adding worker-task authentication to an existing Cloud Tasks deployment, provision the shared token and update task/Scheduler senders before enabling guarded worker receivers. Tasks queued before the sender update do not contain the header; their durable PostgreSQL jobs remain available to the recovery sweep.

In-flight Cloud Tasks pushes that were enqueued against the old combined worker URL will keep arriving at `/internal/tasks/website-crawl` on the **document worker** for a few minutes. The document worker responds `410 Gone` to that path so Cloud Tasks stops retrying immediately. Scheduled recovery in the crawler worker then reclaims those jobs on its next run. The 410 stub is a one-release compatibility shim and can be removed after the next release.

## Disabling the crawler

Set `WEBSITE_CRAWLER_ENABLED=false` on the backend (and on the crawler worker, if you keep it deployed). With the flag off:

- `POST /api/v1/document/crawl` and `GET /api/v1/document/crawl/jobs` return `404`. Existing crawl jobs in the database are untouched.
- The dashboard hides the "Crawl Website" button, skips polling for crawl jobs, and never renders the status banner. The signal travels through `GET /api/v1/workspace/summary` as `websiteCrawlerEnabled: false`.
- The crawler worker entrypoints (`start:crawler-worker` and `start:crawler-worker-server`) log a single message and exit cleanly so the container can be removed from compose, k8s, or Cloud Run.

The flag is global to the deployment; it is exposed per-workspace in the summary because that is where the dashboard needs it. A self-hosted operator who does not want crawler functionality only needs to set this one variable — the document processing pipeline is unaffected.
