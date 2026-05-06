# Contract Notes: Enterprise Website Crawler

## POST /api/v1/ee/website-crawler/crawl

Enterprise-only authenticated workspace route. This route is mounted by the Enterprise backend module through the existing route-mount extension point.

### Request

```json
{
  "url": "https://example.com",
  "limit": 10
}
```

Rules:

- Caller must authenticate with an active workspace session or workspace-scoped API token.
- Cookie-session requests select the workspace with `x-workspace-id`; bearer-token requests use the token workspace.
- `url` must be HTTP or HTTPS.
- `limit` is optional and capped by Enterprise crawler configuration.

### Success Response: 202 Accepted

```json
{
  "provider": "custom-crawler",
  "runId": "provider-run-id",
  "requestedUrl": "https://example.com",
  "accepted": 2,
  "failed": 0,
  "documents": [
    {
      "externalDocumentId": "website:https://example.com:https://example.com/about",
      "documentId": "00000000-0000-0000-0000-000000000001",
      "status": "queued",
      "sourceUrl": "https://example.com/about",
      "canonicalUrl": "https://example.com/about"
    }
  ],
  "failures": []
}
```

### Disabled Response: 503 Service Unavailable

```json
{
  "error": {
    "code": "service_unavailable",
    "message": "Enterprise website crawler is not configured"
  }
}
```

### Validation Response: 400 Bad Request

```json
{
  "error": {
    "code": "bad_request",
    "message": "Invalid website crawl request"
  }
}
```

## Provider Port

Enterprise hosts supply a provider through `createEnterpriseBackendModule({ websiteCrawlerProvider })`. The provider implements `WebsiteCrawlerProvider`, accepts a normalized URL and bounded page limit, and returns normalized page results. Concrete crawler transport, credentials, persistence, retries, and pagination remain inside that provider implementation and are not part of OSS Radioso.

Provider secrets are never exposed in route responses, audit events, document metadata, or logs.

## Message Queue Impact

No new cross-service queue contract is introduced. Document processing continues to use existing document ingestion and document worker dispatch behavior.
