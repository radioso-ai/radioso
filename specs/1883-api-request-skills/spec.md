# Feature Specification: API request skills

**Feature Branch**: `feat/api-request-skills`

**Created**: 2026-11-21

**Status**: Approved for implementation (design revision 2, the typed data contract).

**Input**: Issue #1883. An agent cannot call a REST API and use the answer. Webhook skills POST a signed envelope and drop the response; the only data-returning skill is an MCP tool, so an operator who wants "look up my order" must run an MCP server.

## Principle

The operator declares a typed contract once; code enforces it on both edges; the model only ever sees named, typed, described values, never raw JSON.

## User Scenarios & Testing

### User Story 1 — Connect an API (P1)

An operator adds an API connection in Settings: a name, an https base URL, an auth scheme (`none`, `bearer`, `header`, `basic`), the credential, and non-secret default headers. The credential is write-only; reads show only its masked tail.

**Acceptance**: creating, reading, updating and deleting a connection never returns the credential; a duplicate name (case-insensitive) is a 409; a plain-http, query-carrying or private base URL is a 400; a header-scheme connection without a header name, or a scheme without its credential, is a 400; default headers that set `authorization`, `cookie`, `host` or a transport header are a 400; deleting a connection a skill targets is a 409 that names the skills.

### User Story 2 — Declare a request (P1)

An operator creates an `api_request` skill on the connection: a method, a path with `{param}` placeholders, bound params (fixed values), typed exposed params, and typed outputs (scalars and lists with card roles). A test request against the connection shows the status, the outcome, the projected outputs, any missing required outputs and the parsed body, so the operator can pick output paths.

**Acceptance**: a placeholder that names no declared param, a key both bound and exposed, an exposed param without a type, an output path past ten segments or through `__proto__`, a role set twice in one list, or a non-text image or link field is refused on save. `agent_selectable` and `default_answer` are refused: routines run API requests.

### User Story 3 — Run it from a routine (P1)

A routine step calls the skill by name. Its inputs come from slots and context variables; each is coerced to its type. The response is projected onto the declared outputs; the routine sets variables from them, guards on them, and branches on the outcome.

**Acceptance**: a missing required input settles `missing_input` and sends nothing; a value that does not fit its type settles `invalid_input` and sends nothing; a 2xx with every required output present settles `completed` with only the declared outputs; a 404 settles `not_found`; any other 4xx except 401, 403 and 429 settles `rejected`; a required output left absent fails with `response_mismatch`.

### User Story 4 — Only verified identities read personal data (P1)

An exposed param marked `verifiedOnly` takes a value only from a context variable the host verified (a signed one). A visitor who types someone else's email into a slot cannot read that person's orders.

**Acceptance**: a value from a slot, an unverified context variable or a literal, or no value, settles `unverified` and sends nothing; the same value from a verified context variable is sent.

### User Story 5 — Test Chat and replays (P2)

A GET only reads, so Test Chat and eval replays run it for real; any other method acts outside the conversation and is suppressed there, as a webhook skill is.

### User Story 6 — The model reads typed values (P2)

The routine's next-step selector and the skill-result reply context read the outputs as typed, described lines (`status — Order status (text): "shipped"`; lists as numbered items). Cards built from a list output with roles take their key, title, subtitle, image and link from the roles; the model chooses only which records to show. A result without a contract (an MCP tool today) reads as before.

### Edge Cases

- A path value that is empty, `.` or `..` is `invalid_input`: it cannot walk the base path.
- A redirect is followed only for a GET, only within the origin, at most three hops; any other is `redirect_refused`.
- An empty body is no data: every output is absent, so only a required one fails the skill.
- An empty list output counts as absent, so a field guard's "is set" means "found any".
- A credential the configured key cannot decrypt fails the request with `credential_unavailable`; the connection reads as `****`.

## Requirements

### API connection

- Table `api_connections` (migration 267): `name` unique per workspace case-insensitively, `base_url` (https, or loopback http for local development, by CHECK), `auth_scheme`, `auth_header_name`, `credential_ciphertext` (CONNECTOR_ENCRYPTION_KEY, listed in `ENCRYPTED_FIELD_LOCATIONS`), `default_headers jsonb`, timestamps. A CHECK ties each scheme to its credential and header name.
- `agent_skills.kind` gains `api_request`; `enforce_agent_skill_target_reference` requires it to target an `api_connection` in its own workspace; a BEFORE DELETE trigger blocks deleting a connection a skill targets. Both raise 23503 `agent_skills_api_request_target_fk`.
- Base URLs are checked public on save; plain http to this machine is allowed only where `WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK` is set outside production, the webhook destinations' rule. No new environment variable.

### HTTP contract (session only; reads need `workspace.settings.read`, writes and the test request `workspace.settings.manage`)

| Route | Body | Response |
|---|---|---|
| `GET /api/v1/settings/api-connections` | | `{ connections: ApiConnection[] }` |
| `POST /api/v1/settings/api-connections` | `{ name, baseUrl, authScheme?, authHeaderName?, credential?, defaultHeaders? }` | 201 `{ connection }` |
| `GET /api/v1/settings/api-connections/:connectionId` | | `{ connection }` |
| `PATCH /api/v1/settings/api-connections/:connectionId` | any subset; an omitted credential is kept; `authHeaderName: null` clears | `{ connection }` |
| `DELETE /api/v1/settings/api-connections/:connectionId` | | 204; 409 `api_connection_in_use` |
| `POST /api/v1/settings/api-connections/:connectionId/test-request` | `{ method, path, boundParams?, exposedSampleValues?, outputs? }` | `{ httpStatus, durationMs, outcome, reason?, outputs, mismatches, body, bodyTruncated }` |

`ApiConnection` is `{ id, name, baseUrl, authScheme, authHeaderName, credentialMask, defaultHeaders, createdAt, updatedAt }`. Skills are created through the existing `POST /api/v1/agents/:agentId/skills` with capability `api_request`, target `{ kind: "api_connection", id }`.

### Skill config

```
{ method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: "/orders/{order_number}",
  boundParams:   { [key]: JsonValue },
  exposedParams: { [key]: { type, description?, slotBinding?, required = true, verifiedOnly = false } },
  outputs:       { [name]: ScalarOutput | ListOutput } }
ScalarOutput = { path, type: text|number|boolean|date|email, description?, required = false }
ListOutput   = { path, type: "list", description?, required = false, maxItems = 10 (1..20),
                 fields: { [name]: ScalarOutput & { role?: key|title|subtitle|image|link } } }
```

- Placement: a `{key}` placeholder takes that param URL-encoded; the rest go in the query string for GET and DELETE, or a JSON body for POST, PUT and PATCH, where a dotted key nests. Keys follow the webhook payload-key rule (`shared/domain/skillPayloadKey.ts`).
- Value types are the routine slot types without `item` (pinned by a test). Coercion: text as written; number from a number or a plain decimal; boolean from `true`/`false`; date as an ISO date for inputs, an ISO date or date-time for outputs; email trimmed and checked by the email slot's rule.
- Outcomes: `completed`, `not_found`, `rejected`, `missing_input`, `invalid_input`, `unverified`, `failed`. Failure reasons: `response_mismatch`, `outputs_too_large`, `non_json_response`, `timeout`, `network`, `upstream_error`, `auth_rejected`, `rate_limited`, `redirect_refused`, `connection_not_found`, and the cases the design leaves unnamed: `blocked`, `response_too_large`, `credential_unavailable`, `skill_not_found`, `invalid_config`, `context_missing`. No retries.
- Limits: 10 s for the whole request, 1 MB response read on the stream, 16 KB of serialized outputs, 16 KB of test-request body.

### What the model reads

`SkillOutcome` and `RoutineSkillResult` carry an optional `outputContract` (name → `{ type, description?, fields? }`). The routine dispatcher copies it, the runner stages it with the skill result, and the next-step selector, the reply context and card building read it. The renderer is `renderSkillOutputLines` in `@radioso/conversation-contract`.

### Authoring

The authoring descriptor lists the typed exposed params as inputs and the declared outputs with their types and list fields (`hasDataOutputs` is true when any are declared). The routine validator refuses a slot whose type cannot feed a typed input; a text input takes any slot type.

### Operator copilot

`propose_skill_config` and `agent_skills` handle `api_request` generically. The capability shows no settings value to the model, so the copilot reads config key names only, as for webhook skills. `listApiConnections` and `getApiConnection` map to `agent_skills`, as MCP connections do. Connection create and update carry the credential, delete cannot be undone without it, and the test request returns a raw response body: all four are permanent exclusions.

## Design discipline

**What each part knows, and what it must not.**

- `shared/infra/http/publicHttpRequest.ts` knows HTTP and the egress policy: methods, bodies, the deadline, the stream cap, same-origin GET redirects, the public-address check per hop. It knows nothing about skills, connections or auth schemes. It composes `fetchPublicUrl` (DNS pinning) and the bounded body reader from `publicBytesFetch.ts`.
- `shared/domain/skillDataContract/` knows value types, coercion, output declarations, projection, the response check and the model-facing contract. It knows nothing about HTTP, MCP, routines, turns or connections. It sits in `shared/domain` because `skills/capabilities/*` import executor modules, so an executor importing `skills` would close a cycle.
- `modules/apiRequestSkills/` knows connections, param placement, typed input resolution, the verified-only gate, outcome mapping and the test request. It does not know routines, turns or the egress policy.
- `routines/skillDispatcher.ts` knows argument origins and trust; it does not know HTTP.
- `app/server/builders/apiRequestSkills.ts` assembles the service and the executor; no domain imports composition.

**Ports, per consumer.**

- The executor takes a structural skill source (`findByName`, satisfied by the agent skill repository), an `ApiConnectionTargetResolver` (the connection service), and an `ApiRequestSender` (the transport, with the loopback rule, from composition).
- The connection service takes `ApiConnectionRepositoryPort` and a local `ApiConnectionAuditPort` shaped like the audit module's `record`; importing the audit module would close a cycle through retrieval and routines.
- The routine resolver is structurally a `RoutineSkillResolver` and does not import the routines module, which imports it.

**Dependency direction.** `skills` and `routines` depend on `apiRequestSkills`; `apiRequestSkills` depends only on `shared` and the contract packages. The architecture ratchet records no new module edge.

**Deviations from the design, each the smallest correct one.**

- The model-facing renderer lives in `@radioso/conversation-contract`, beside `readableSlotValue`, not in `shared/domain/skillDataContract`: the next-step selector is in `conversation-defaults`, which cannot import backend code.
- Context variables resolved by an `api_request` skill are out of scope, so the context-variable resolver refuses the kind rather than mapping it to the executor.
- The failure reasons add six codes for cases the design does not name (listed above).
- The test-request response adds `bodyTruncated`, so the form can say the body was cut.
- The skill resolver for `api_request` filters on `enabled && routine_named`, as the retrieve and notify resolvers do, so `routineInvocableSkillNames` lists it among the kinds it leaves out.

## Observability

- Span `api_request.skill.dispatch`: skill name, connection id, method, status code, outcome, reason, the names of missing required outputs, duration.
- Counter `api_request_skill_dispatch_total{outcome, reason}`; `reason` is the bounded code set, `none` when not failed; no skill-name label.
- Warn log `api_request_skill_failed` with workspace, agent, skill and connection ids, method, reason, status, missing output names.
- Audit events `api_connection.create`, `.update` (with whether the credential changed), `.delete` and `.test_request` (method, outcome, reason, status).
- Never logged, traced or counted: URLs (paths and queries carry personal data), headers, credentials, request or response bodies, param or output values.

## Out of scope

Directive and turn binding; context-variable resolvers backed by API requests; OpenAPI import or discovery; OAuth client credentials and API keys in the query string; retries; pagination; non-JSON responses as data; nested body templates beyond dotted keys. Follow-ups: chaining a picked item's fields into later skill inputs, and MCP tool skills adopting the typed contract.
