# Feature Specification: Enterprise Website Crawler Provider

**Feature Branch**: `057-ee-website-crawler`
**Created**: 2026-05-06
**Status**: Draft
**Input**: User description: "Build the Enterprise-tier website crawler provider port. Enterprise Edition owns the website crawler provider port, provider types, composition hook, and crawler-specific route/service behavior inside ee/packages/backend-module. OSS Radioso must not gain crawler-specific composition hooks or crawler domain concepts. This slice should support an EE provider abstraction and publishing crawled pages into existing Radioso document ingestion with stable external document IDs and source metadata."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Configure Enterprise Crawling (Priority: P1)

An Enterprise operator can enable a website crawler provider for Radioso Enterprise without adding crawler-specific concepts to the open-source application composition or OSS domain modules.

**Why this priority**: The feature exists to keep website crawling a paid Enterprise capability while preserving the OSS product boundary. If the core app learns about crawler-specific providers, the tier boundary is wrong.

**Independent Test**: Can be fully tested by loading the Enterprise backend module with and without crawler configuration and confirming that only Enterprise module code owns crawler provider selection, validation, and failure behavior.

**Acceptance Scenarios**:

1. **Given** the Enterprise backend module is loaded with valid crawler provider configuration, **When** the module initializes crawler functionality, **Then** an Enterprise-owned provider is available to Enterprise crawler services.
2. **Given** crawler configuration is absent or disabled, **When** the Enterprise backend module starts, **Then** crawler routes or services fail predictably as unavailable without preventing unrelated Enterprise features from registering.
3. **Given** the OSS application composition is inspected, **When** this feature is installed, **Then** there are no crawler-specific registration hooks, crawler capability policies, or crawler domain modules in OSS code.

---

### User Story 2 - Crawl A Website Into Workspace Documents (Priority: P2)

An Enterprise user can submit a website URL for crawling and have returned pages published as existing Radioso documents for the selected workspace so chat, retrieval, citations, and embeddings continue to use the established document pipeline.

**Why this priority**: The business value is turning website content into chatbot-ready context. Publishing into the existing document pipeline prevents duplicate retrieval infrastructure.

**Independent Test**: Can be fully tested with a fake crawler provider that returns multiple pages and a fake document ingestion service that records published document requests.

**Acceptance Scenarios**:

1. **Given** a configured crawler provider returns two page results, **When** an Enterprise crawl request is submitted for a workspace, **Then** both pages are passed to document ingestion as queued document writes.
2. **Given** the same provider page is returned in a repeated crawl, **When** the page is published again, **Then** the same external document identity is used so the existing document API treats the write as an idempotent update within the workspace.
3. **Given** a crawled page has a source URL and canonical URL, **When** the page is published, **Then** document metadata includes source URL, canonical URL, provider run identity when available, and a website-source marker usable by retrieval citations and filtering.

---

### User Story 3 - Surface Provider Failures Safely (Priority: P3)

An Enterprise operator receives clear failure outcomes when crawler configuration, provider requests, or document publication fail, while customer data and secrets remain protected.

**Why this priority**: Website crawling depends on external network calls and optional provider credentials. Failures must be diagnosable without leaking secrets or corrupting documents.

**Independent Test**: Can be fully tested by configuring fake provider and document-ingestion failures and asserting route/service responses plus audit metadata.

**Acceptance Scenarios**:

1. **Given** the provider rejects a crawl request, **When** the Enterprise crawler service handles the failure, **Then** the user receives a clear failed outcome and no partial success is reported.
2. **Given** document ingestion rejects one page after other pages were accepted, **When** the Enterprise crawler service returns, **Then** the response distinguishes accepted and failed page publications without retrying in a hidden loop.
3. **Given** crawler credentials are configured, **When** failures are logged or audited, **Then** secret values are not included in logs, audit events, responses, or document metadata.

### Edge Cases

- Provider disabled or missing from Enterprise module composition.
- Provider returns zero pages for a valid URL.
- Provider returns duplicate pages with the same canonical URL in one crawl response.
- Provider returns pages without titles, canonical URLs, or provider run identifiers.
- Provider returns unsupported binary or empty content.
- Document ingestion accepts some pages and rejects others.
- Repeated crawls publish updated content for an already imported page.
- Provider timeout or network failure occurs after a request is accepted.
- A request is made for a workspace the caller cannot access.
- Provider configuration changes while the backend process is already running.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Enterprise Edition owns all crawler-specific concepts, including the provider port, provider composition hook, generic crawler limits, crawler service, crawler routes, provider errors, and provider response mapping. OSS Radioso continues to own only generic application module route mounting, dependency injection, document ingestion, document processing, retrieval, and chat.
- **Encapsulation Rule**: `backend/src/app/composition/` must not gain crawler-specific registration hooks or crawler-specific default behavior. `backend/src/modules/documents/` must remain the owner of document ingestion and processing, not crawler orchestration. `ee/packages/backend-module/src/index.ts` may register Enterprise routes, but crawler domain behavior should live in focused Enterprise crawler modules rather than expanding the module index.
- **New Seams Required**: Add an Enterprise-owned `WebsiteCrawlerProvider` contract, an Enterprise module composition hook for supplying a provider, an Enterprise crawler publication service that maps provider pages to document ingestion calls, and tests around the provider boundary. If an HTTP route is added, it must stay transport-only and delegate to the Enterprise crawler service.
- **Anti-Goals**: Do not add `registerWebsiteCrawlerProvider` or any crawler-specific extension point to OSS composition. Do not import Botobot crawler code in this slice. Do not add a persistent crawl frontier, long-running crawler worker, website-source UI, Crawlee local engine, or retrieval ranking changes. Do not bypass existing Radioso document ingestion or write chunks/embeddings directly from crawler code.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Enterprise Edition MUST define a crawler provider contract that can request a website crawl and return page-level results with content, source URL, canonical URL when available, title when available, and provider run metadata when available.
- **FR-002**: Enterprise Edition MUST provide a disabled or unavailable crawler state when no crawler provider is supplied through Enterprise module composition, without adding crawler-specific behavior to OSS application composition.
- **FR-003**: Enterprise Edition MUST expose a provider-agnostic composition hook so custom crawler software can satisfy the `WebsiteCrawlerProvider` port.
- **FR-004**: Enterprise Edition MUST validate generic crawler request limits at the Enterprise module boundary and fail crawler operations with clear errors when limit settings are invalid.
- **FR-005**: Enterprise crawler services MUST publish crawled pages through the existing Radioso document ingestion path for the target workspace.
- **FR-006**: Enterprise crawler services MUST generate stable external document IDs from website source identity and page canonical/source URL so repeated crawls update the same page document within the selected workspace instead of creating duplicates.
- **FR-007**: Enterprise crawler services MUST attach source metadata to each published document, including at minimum `sourceKind`, `sourceUrl`, `canonicalUrl` when available, `websiteBaseUrl`, and provider run identity when available.
- **FR-008**: Enterprise crawler services MUST report how many pages were accepted for ingestion and how many failed publication in the operation result.
- **FR-009**: Enterprise crawler services MUST not include provider secrets in responses, logs, audit metadata, document metadata, or test fixtures.
- **FR-010**: Enterprise crawler services MUST enforce existing workspace access patterns for any user-triggered crawl route.
- **FR-011**: If an Enterprise HTTP route is added, it MUST be mounted only through the existing Enterprise backend module route-mount mechanism.
- **FR-012**: Backend tests MUST prove that OSS application composition does not expose or require crawler-specific provider registration.
- **FR-013**: Backend tests MUST prove that Enterprise provider composition, disabled-provider behavior, provider result mapping, idempotent external document IDs, and partial document-publication failures behave as specified.
- **FR-014**: Configuration documentation MUST list every new Enterprise crawler environment variable without committing secrets.
- **FR-015**: Message-queue impact review MUST conclude whether document worker dispatch payloads, AMQP queue payloads, retry semantics, queue docs, or queue tests change. The intended outcome for this slice is no queue contract change because crawler publication uses existing document ingestion.

### Key Entities *(include if feature involves data)*

- **Website Crawler Provider**: Enterprise-owned abstraction that accepts a website crawl request and returns normalized page results.
- **Website Crawl Request**: The workspace-scoped request to crawl a website URL with optional page limit and provider options.
- **Website Crawl Page Result**: A normalized page from the provider, including text content, title, source URL, canonical URL, and provider metadata.
- **Website Crawl Publication**: The Enterprise-owned mapping from page result to Radioso document ingestion, including stable external document identity and source metadata.
- **Crawler Provider Configuration**: Enterprise environment-driven settings for generic crawler limits. Concrete provider endpoint and credential handling belong to the provider implementation supplied through Enterprise module composition.

## Assumptions

- The first slice proves the Enterprise provider architecture and document publication path; it does not attempt to build the final website-source product UI.
- Concrete crawler implementations are supplied outside this slice through the Enterprise-owned provider port; this slice does not ship a Firecrawl, Crawlee, Botobot, or other concrete adapter.
- Crawler output is treated as source material for Radioso documents; chunking, embedding, retrieval, citations, and chat behavior remain owned by existing Radioso services.
- The feature can use existing Enterprise route-mount dependencies to reach document ingestion and workspace session behavior.
- No backend runtime LLM prompts are introduced by this feature.
- No frontend user interface is introduced by this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In automated tests, 100% of crawler-specific provider types, composition hooks, services, and routes live under Enterprise code paths.
- **SC-002**: In automated tests, OSS application composition continues to build and pass composition tests without any crawler-specific registration hook or default crawler provider.
- **SC-003**: In automated tests, a fake provider returning three unique pages causes exactly three document ingestion requests with stable external document IDs and source metadata.
- **SC-004**: In automated tests, a repeated crawl of the same page produces the same external document ID.
- **SC-005**: In automated tests, missing-provider failures and provider request failures produce clear unavailable or failed outcomes without leaking configured secrets.
- **SC-006**: In automated tests, partial document publication failures are reflected in the operation result without reporting full success.
- **SC-007**: Documentation and `.env.example` list the Enterprise crawler limit settings and document the provider composition hook.
