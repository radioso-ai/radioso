# Feature Specification: High-Cardinality Cursor Hardening

**Feature Branch**: `borohhov/large-result-cursors`  
**Created**: 2026-04-04  
**Status**: Draft  
**Input**: User description: "Plan 1 and 2 for 10M+ chunk readiness: harden remaining large-result-set paths and move large collections from offset to cursor pagination."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse large collections safely (Priority: P1)

A workspace operator can open collection-heavy product surfaces such as Documents,
Chat History, public conversation history, and document search history without
causing unbounded backend reads or loading entire libraries into memory.

**Why this priority**: Preventing backend instability is the first requirement
for any larger-scale deployment. Until the remaining high-cardinality reads are
bounded, the system remains vulnerable even before chunk volume reaches the
target scale.

**Independent Test**: Seed a workspace with large document, conversation, and
search-history collections, load each list endpoint, and confirm each request
returns only a bounded result window without destabilizing the backend.

**Acceptance Scenarios**:

1. **Given** a workspace with tens of thousands of documents, **When** the
Documents page loads, **Then** the backend returns only a bounded summary window
instead of the full document library.
2. **Given** a workspace with large saved chat history and document search
history, **When** the operator opens those views, **Then** each request remains
bounded and the backend stays responsive.
3. **Given** a long-lived public anonymous session with many conversations,
**When** the session history loads, **Then** only a bounded summary window is
returned.

---

### User Story 2 - Traverse large collections predictably (Priority: P1)

A workspace operator can move through large document and history collections
using stable cursor-based windows that do not degrade as the collection grows.

**Why this priority**: Bounded reads alone are not enough. Large collections
must remain navigable without deep offset scans that become slower and less
stable at scale.

**Independent Test**: Request multiple consecutive collection windows while
concurrent inserts and deletes occur, and confirm that the client receives a
stable next window without duplicate or skipped records.

**Acceptance Scenarios**:

1. **Given** a large document library, **When** the operator requests the next
document window, **Then** the system uses a continuation cursor rather than a
deep offset and returns the correct next slice in sort order.
2. **Given** a large chat history collection, **When** a new conversation is
created between page requests, **Then** the next requested history window
remains valid and predictable.
3. **Given** multiple records sharing the same timestamp, **When** a cursor
window boundary falls on those records, **Then** the system preserves a stable
tie-break order and avoids duplicate or missing entries.

---

### User Story 3 - Open long conversations without full-history loads (Priority: P2)

An operator or anonymous end user can open a conversation with many stored
messages and load older history incrementally rather than fetching the full
message history at once.

**Why this priority**: Long-lived conversations are a hidden high-cardinality
path. Hardening only summary lists would leave detail endpoints as a remaining
scale risk.

**Independent Test**: Open a conversation with many stored messages, verify the
initial response returns a bounded message window, then request older windows
until the conversation is exhausted.

**Acceptance Scenarios**:

1. **Given** a conversation with many stored messages, **When** its detail view
opens, **Then** the backend returns only the newest bounded message window plus
continuation metadata for loading older messages.
2. **Given** a previously loaded message window, **When** the user requests
older messages, **Then** the next older bounded window is returned in correct
chronological order.
3. **Given** messages are deleted or inserted while the user browses history,
**When** the next message window is requested, **Then** the request fails safely
or continues predictably without returning the entire conversation history.

---

### User Story 4 - Verify every high-cardinality path is covered (Priority: P3)

An engineer can review a durable inventory of collection-returning routes and
see which paths were already bounded, which required hardening, and which were
migrated from offset to cursor traversal.

**Why this priority**: This work is partly architectural remediation. The repo
needs an explicit inventory so future features do not reintroduce unbounded list
or detail behavior.

**Independent Test**: Review the completed route inventory and confirm every
user-generated high-cardinality route is classified and mapped to its bounded
strategy.

**Acceptance Scenarios**:

1. **Given** the collection-returning routes in the app, **When** the feature
is reviewed, **Then** each route is categorized as already bounded, newly
hardened, or intentionally out of scope with justification.
2. **Given** the final implementation docs, **When** an engineer reviews the
feature package, **Then** they can identify the cursor contract, owning modules,
and validation expectations for each hardened path.

### Edge Cases

- A collection has zero results and still returns a valid empty page with no
  continuation cursor.
- The final collection window contains fewer results than the standard page
  size.
- Rows are inserted or deleted between one cursor request and the next.
- Multiple rows share the same sort timestamp and require a deterministic
  tie-breaker.
- A client presents an invalid, malformed, or stale cursor token.
- A user requests older conversation messages after the conversation was
  partially deleted.
- Existing small low-cardinality configuration lists remain unchanged unless
  analysis proves they are user-generated and effectively unbounded.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Backend HTTP contract changes MUST be defined in the code-first OpenAPI registry and regenerated from code rather than hand-editing generated artifacts.
- Any user-visible contract or workflow change MUST update the corresponding docs in the same feature work.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP routes own request validation and response shaping
only. Collection traversal rules belong to focused read services. Repository
methods own bounded SQL access patterns. Frontend API clients and views own
cursor storage and navigation state.
- **Encapsulation Rule**: [backend/src/app/http/routes/documentRoutes.ts](/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/routes/documentRoutes.ts),
  [backend/src/app/http/routes/chatRoutes.ts](/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/routes/chatRoutes.ts),
  and [backend/src/app/http/routes/publicChatRoutes.ts](/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/routes/publicChatRoutes.ts)
  must remain transport-only. Existing repositories must not continue exposing
  unbounded collection reads for hot product paths once cursor-capable methods
  exist.
- **New Seams Required**: A shared cursor codec contract, dedicated
  cursor-based repository methods for each high-cardinality collection, and a
  route inventory artifact that records bounded strategy ownership for each path.
- **Anti-Goals**: Do not keep offset pagination as the primary traversal method
  for large collections. Do not fetch full document bodies for list browsing. Do
  not fetch complete conversation message history on initial detail load. Do not
  hide scale issues behind larger process limits, longer timeouts, or payload
  size increases.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST identify every user-generated application route
  that can return a large result set and classify each route as already bounded,
  newly hardened, or intentionally excluded with justification.
- **FR-002**: The system MUST remove or retire unbounded backend read paths for
  document list browsing, chat history browsing, anonymous conversation
  browsing, and conversation message history used by normal product flows.
- **FR-003**: The system MUST support bounded summary retrieval for authenticated
  document list browsing.
- **FR-004**: The system MUST support bounded summary retrieval for
  authenticated chat history browsing.
- **FR-005**: The system MUST support bounded summary retrieval for anonymous
  conversation browsing.
- **FR-006**: The system MUST support bounded summary retrieval for document
  search history browsing.
- **FR-007**: The system MUST support bounded conversation message window
  retrieval for authenticated and anonymous conversation detail views.
- **FR-008**: Large-collection traversal endpoints MUST expose cursor-based
  continuation instead of deep offset traversal.
- **FR-009**: Cursor ordering MUST be deterministic and include a stable
  tie-breaker when multiple rows share the same primary sort timestamp.
- **FR-010**: Invalid or malformed cursor inputs MUST fail safely with a clear
  client-visible error and MUST NOT trigger unbounded fallback reads.
- **FR-011**: Collection responses MUST include only the fields needed for
  browsing and list-level actions.
- **FR-012**: Existing sort order semantics for Documents, chat history,
  anonymous history, and conversation message history MUST be preserved unless
  explicitly revised by this feature.
- **FR-013**: The frontend MUST request only the current collection window
  during normal browsing and MUST NOT reload the full collection after standard
  list actions.
- **FR-014**: The code-first OpenAPI registry at
  `backend/src/app/http/openapi/document.ts` MUST be updated to describe any new
  cursor-based request and response contracts, and the generated OpenAPI outputs
  MUST be regenerated.
- **FR-015**: The feature MUST add automated coverage for each hardened
  high-cardinality path, including representative large-data validation for at
  least one collection at the scale that previously stressed the backend.
- **FR-016**: Feature documentation MUST describe the route inventory, cursor
  contract, and any operator-visible browsing changes introduced by the
  migration.

### UI Tasks

- Update Documents browsing to use continuation-based window loading without
  full-library reloads.
- Update Chat History and anonymous conversation browsing to use continuation
  metadata for next-window traversal.
- Update long conversation history views to load older messages incrementally.
- Preserve clear empty, loading, and failure states for all list and
  conversation-history surfaces.
- Keep list-level actions working without requiring the browser to hold the full
  collection.

### Key Entities *(include if feature involves data)*

- **Collection Cursor**: An opaque continuation token that encodes the current
  traversal boundary for a sorted collection.
- **Collection Window**: A bounded slice of list results plus continuation
  metadata describing whether additional results remain.
- **Message Window**: A bounded chronological slice of one conversation's
  messages plus metadata for requesting older history.
- **Route Inventory Entry**: A durable record in the feature docs identifying a
  high-cardinality route, its bounded strategy, its owner, and its validation
  status.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Documents, chat history, anonymous conversation history, and
  document search history all load through bounded result windows under
  representative large datasets without backend restarts during validation.
- **SC-002**: The primary collection traversal paths no longer depend on deep
  offset scans once the feature is enabled.
- **SC-003**: Users can request the next collection window and older message
  windows without duplicate or skipped records in representative validation
  scenarios.
- **SC-004**: Conversation detail endpoints no longer require the full stored
  history to render the initial view.
- **SC-005**: The route inventory explicitly covers every user-generated
  high-cardinality path reviewed by the feature.
