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

### Document and source metadata

Per-document metadata is intentionally narrow:

| Field | Notes |
|-------|-------|
| `sourceUrl` | Always present. The page URL the crawler fetched. |
| `canonicalUrl` | Always present. Equals `sourceUrl` when the page has no separate canonical, so consumers can rely on the key. |
| `httpStatus`, `etag`, `lastModified` | Optional. Pulled from the provider via a fixed allow-list and only when truthy. Useful for incremental re-crawl decisions. |

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

Returns recent crawl jobs for the current workspace. The dashboard uses this endpoint to show queued, running, completed, and failed crawls without polling each document.

Query parameters are all optional:

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `status` | `queued` \| `processing` \| `completed` \| `failed` | unset (any) | Filter to a single status. |
| `sinceMinutes` | integer 1-1440 | `30` | Only return jobs created in this window. |
| `limit` | integer 1-200 | `50` | Maximum number of jobs to return. |

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
      "lastError": null,
      "createdAt": "2026-05-11T10:00:00.000Z",
      "updatedAt": "2026-05-11T10:05:00.000Z",
      "completedAt": "2026-05-11T10:05:00.000Z"
    }
  ]
}
```

`documentCount` is derived from the worker result (`accepted` pages). It is `null` for jobs that have not completed yet. `lastError` is populated for failed jobs and is `null` otherwise.

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

Scaling defaults are independent: `worker_min_instances` / `worker_max_instances` for the document worker, `crawler_worker_min_instances` / `crawler_worker_max_instances` for the crawler. Both stay at `min = 1` so the polling fallback always has a live recovery process.

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
