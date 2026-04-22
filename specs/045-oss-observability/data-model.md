# Data Model: OSS Observability

## Telemetry Event

**Purpose**: Describe runtime health and execution behavior for HTTP requests,
background work, retrieval stages, and other backend operations.

**Fields**:

- `eventType`: Stable runtime signal name such as request completion, retrieval
  stage completion, or worker failure
- `timestamp`
- `service`
- `environment`
- `version`
- `severity`
- `correlation`: request, workspace, account, conversation, job, or document identifiers where available
- `metrics`: numeric measurements such as duration, counts, or queue size
- `tags`: low-cardinality dimension labels
- `redactionStatus`: whether sensitive fields were removed or omitted

**Validation rules**:

- Must never contain raw prompts, retrieved document text, session cookies, or
  connector credentials by default
- Correlation identifiers are optional but must be stable when present
- Metric values must be numeric and bounded to low-cardinality dimensions

## Product Analytics Event

**Purpose**: Capture product usage and operator behavior in Radioso-owned terms
without depending on vendor-specific schemas.

**Fields**:

- `eventName`: stable Radioso event such as `workspace.created`,
  `document.processing_completed`, or `chat.completed`
- `timestamp`
- `workspaceId`
- `accountId`
- `actorType`: operator, authenticated user, anonymous user, system
- `subjectType`: workspace, document, conversation, settings, embed session
- `subjectId`
- `properties`: bounded event properties relevant to the action
- `source`: backend, worker, frontend, embed

**Validation rules**:

- Event names must come from a controlled taxonomy owned by Radioso
- Exported user identifiers must be minimized or pseudonymized when leaving
  Radioso-controlled infrastructure
- Properties must exclude secrets, prompts, and raw document contents

## Incident Event

**Purpose**: Normalize crashes, operational failures, and unexpected error paths
before persistence or optional export.

**Fields**:

- `incidentType`: unhandled exception, external dependency failure, validation
  escape, exporter failure, worker failure
- `timestamp`
- `severity`
- `service`
- `environment`
- `version`
- `message`
- `errorClass`
- `stack`
- `correlation`
- `requestContext`: method, route, status, request identifier
- `breadcrumbs`: selected prior signals
- `tags`

**Validation rules**:

- Stack and message content must pass redaction before any external export
- Request context must exclude raw bodies unless a safe redacted form exists
- Incident records must exist even when no external sink is configured

## Observability Sink

**Purpose**: Represent a destination that receives telemetry, product analytics,
or incident events.

**Fields**:

- `sinkType`: audit, log, metrics, webhook, vendor adapter
- `enabled`
- `deliveryMode`: synchronous local, asynchronous local, asynchronous external
- `failurePolicy`: drop, retry, persist-first, log-and-continue
- `redactionPolicy`

**Relationships**:

- Telemetry events can fan out to log and metrics sinks
- Product analytics events must land in a first-party sink before optional
  external export
- Incident events must land in a first-party sink and may then fan out to
  optional exporters

## Redaction Policy

**Purpose**: Define what event data may leave process memory, be persisted, or
be exported.

**Fields**:

- `policyName`
- `appliesTo`: telemetry, analytics, incidents
- `blockedFields`
- `hashedFields`
- `allowedFields`
- `exportLevel`: local-only, first-party persistence only, external-safe

**Validation rules**:

- Policies must default to deny for secrets and raw model/document content
- External-safe export must be stricter than first-party persistence

## Derived Runtime Relationships

- `createApp.ts` and runtime middleware emit telemetry and incidents through
  dedicated services but do not own event schemas.
- Domain services such as chat, retrieval, documents, and settings emit product
  analytics through a shared analytics interface.
- `AuditService` and `auditEventRepository` act as the initial durable sink for
  product and incident records until a separate persistence need is proven.
- Optional vendor adapters subscribe behind sink interfaces and never define the
  canonical event schema.
