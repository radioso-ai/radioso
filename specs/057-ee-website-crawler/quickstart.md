# Quickstart: Enterprise Website Crawler Provider

## Configure

Add Enterprise crawler settings to local `.env` or deployment secrets:

```bash
EE_WEBSITE_CRAWLER_DEFAULT_LIMIT=10
EE_WEBSITE_CRAWLER_MAX_LIMIT=100
```

Supply a crawler implementation through the Enterprise module composition hook:

```ts
import {
  createEnterpriseBackendModule,
  type WebsiteCrawlerProvider,
} from "@radioso/enterprise-backend-module";

const websiteCrawlerProvider: WebsiteCrawlerProvider = {
  name: "custom-crawler",
  async crawl(request) {
    return { provider: "custom-crawler", pages: [] };
  },
};

export default createEnterpriseBackendModule({ websiteCrawlerProvider });
```

Omit `websiteCrawlerProvider` to keep crawler operations unavailable.

For local testing with `./run-ee-dev.sh`, put that wrapper in an importable local
package or built file and start the stack with an override such as:

```bash
RADIOSO_APPLICATION_MODULES=file:///absolute/path/to/crawler-ee-module.js ./run-ee-dev.sh
```

The default `./run-ee-dev.sh` module is `@radioso/enterprise-backend-module`,
which intentionally loads without a crawler provider.

## Validate With Tests

```bash
cd ee
npm run test --workspace @radioso/enterprise-backend-module -- --run src/websiteCrawler
```

```bash
cd backend
npm test -- --run tests/unit/default-composition.test.ts
```

## Try The Route Locally

Start the Enterprise stack:

```bash
./run-ee-dev.sh
```

After signing in and selecting a workspace, submit:

```bash
curl -X POST http://localhost:8080/api/v1/ee/website-crawler/crawl \
  -H 'Content-Type: application/json' \
  -H 'x-workspace-id: <workspace-id>' \
  -b 'radioso_session=<session-cookie>' \
  -d '{"url":"https://example.com","limit":3}'
```

Expected result:

- `202 Accepted` when the provider is configured and pages are queued for ingestion.
- `503 Service Unavailable` when crawler configuration is disabled or incomplete.

## Verify Boundaries

- OSS composition tests pass without crawler-specific provider registration.
- Enterprise module owns every crawler-specific type and route.
- Documents created from website pages contain `sourceUrl`, `canonicalUrl`, and `websiteBaseUrl` metadata.
