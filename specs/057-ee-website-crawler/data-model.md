# Data Model: Enterprise Website Crawler Provider

## WebsiteCrawlerProvider

Enterprise-owned port that normalizes external crawler engines.

Fields and behavior:

- `crawl(request)`: returns a `WebsiteCrawlResult`.
- Implementations must not expose provider secrets through errors or metadata.
- Implementations may include provider-specific metadata only after normalization.

## WebsiteCrawlRequest

Workspace-scoped operation requested by an authenticated Enterprise user.

Fields:

- `workspaceId`: Existing Radioso workspace identity.
- `accountId`: Existing Radioso account identity when available.
- `baseUrl`: Starting URL to crawl.
- `limit`: Maximum pages requested for this operation.

Validation rules:

- `baseUrl` must be a valid HTTP or HTTPS URL.
- `limit` must be a positive integer capped by Enterprise configuration.
- Workspace access must be resolved through existing workspace session dependencies before service execution.

## WebsiteCrawlResult

Normalized provider operation result.

Fields:

- `provider`: Provider name, such as `custom-crawler`.
- `runId`: Provider run/job ID when available.
- `pages`: Array of `WebsiteCrawlPage`.
- `status`: Provider status when available.

## WebsiteCrawlPage

Normalized page-level result.

Fields:

- `sourceUrl`: URL from which content was scraped.
- `canonicalUrl`: Canonical URL when available.
- `title`: Page title when available.
- `content`: Markdown or text content used for Radioso document ingestion.
- `metadata`: Safe provider/page metadata.

Validation rules:

- Pages with empty content are skipped or reported as failed publication.
- Duplicate page identities within one crawl are deduplicated before document ingestion.
- Provider metadata must not include credentials.

## WebsiteCrawlPublication

Result of mapping a crawler page to Radioso document ingestion.

Fields:

- `externalDocumentId`: Stable ID derived from website base URL and page canonical/source URL.
- `title`: Page title or fallback URL.
- `content`: Page content.
- `metadata`: Source metadata for citations/filtering.
- `documentId`: Radioso document ID returned by ingestion when accepted.
- `status`: Ingestion status or failed publication status.

State transitions:

- `pending` provider page -> `accepted` when document ingestion accepts it.
- `pending` provider page -> `failed` when ingestion rejects it.
- Repeated page publication with the same identity updates the existing document through existing document ingestion semantics.

## CrawlerProviderConfiguration

Enterprise environment-derived settings.

Fields:

- `defaultLimit`: Default page limit.
- `maxLimit`: Maximum accepted page limit.

Validation rules:

- Provider operations fail as unavailable when no `WebsiteCrawlerProvider` is supplied through Enterprise module composition.
- Concrete provider endpoint, credential, timeout, retry, and pagination settings belong to the provider implementation outside this slice.
- Secret values are never returned from provider errors.
