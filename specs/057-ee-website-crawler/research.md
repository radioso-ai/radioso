# Research: Enterprise Website Crawler Provider

## Decision: Enterprise owns the entire crawler-specific boundary

**Rationale**: The approved scope states crawler functionality is fully Enterprise-tier. Keeping provider contracts and the provider composition hook in EE prevents OSS composition from exposing paid-feature seams or product concepts that do not exist in the OSS tier.

**Alternatives considered**:

- OSS `registerWebsiteCrawlerProvider`: Rejected because it creates an OSS crawler concept.
- Shared package provider types: Rejected for this slice because the type boundary itself would become a cross-tier crawler contract.

## Decision: Use existing Enterprise route mount for the first operation

**Rationale**: The OSS app already allows Enterprise modules to mount routes generically. This avoids a new crawler-specific composition hook while still providing an executable path for tests and operator use.

**Alternatives considered**:

- Add OSS route stubs: Rejected due to tier leakage.
- Build only provider classes with no route: Rejected because the feature should be testable end to end through Enterprise module behavior.

## Decision: Provider-agnostic port first

**Rationale**: The first slice should define how Enterprise Radioso asks for normalized page results and publishes them into document ingestion. Concrete crawl transport, browser/runtime policy, pagination, retries, credentials, and operational state should remain inside the custom provider implementation supplied through the EE composition hook.

**Alternatives considered**:

- Built-in Firecrawl adapter: Rejected because the agreed scope is an abstract provider port, not a concrete off-the-shelf crawler integration.
- Botobot crawler import: Rejected for this slice because the port should stay implementation-agnostic; Botobot can be adapted through the provider hook later.
- Crawlee local engine: Rejected for this slice because a local engine requires frontier, browser runtime, robots/sitemap policy, and recovery decisions that belong in a later worker feature.

## Decision: Request-driven crawl-and-publish operation

**Rationale**: The first slice proves provider selection, provider response normalization, and document publication. A request-driven operation is small enough to validate without adding long-running crawl worker state.

**Alternatives considered**:

- Persistent crawl runs and frontier: Rejected as out of scope.
- Webhook ingestion: Rejected for this slice; it requires signature validation, persistent run state, and asynchronous event handling.

## Decision: Stable external document IDs derive from website identity and page URL

**Rationale**: Radioso already treats `externalDocumentId` as the idempotent key for inline document updates within a workspace. Deriving crawler IDs from the website base URL plus canonical/source page URL lets repeated crawls update existing page documents.

**Alternatives considered**:

- Provider document IDs: Rejected because provider IDs may change across runs.
- Random document IDs: Rejected because repeated crawls would duplicate documents.

## Decision: No queue contract changes

**Rationale**: Publishing pages through `documentIngestionService.ingest` reuses existing document job creation and dispatch behavior. This avoids changing worker payloads, AMQP messages, retry semantics, or queue docs.

**Alternatives considered**:

- Direct document job insertion from EE crawler: Rejected because it would duplicate document ingestion behavior.
- Direct chunk/embedding writes: Rejected because retrieval indexing must remain owned by existing document processing.
