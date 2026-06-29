# Feature Specification: Operator Console — Customer & Usage-Tier Administration

**Feature Branch**: `admin-customer-administration-design` (spec dir `098-operator-console`)
**Created**: 2026-06-29
**Status**: Draft
**Input**: User description: "A first operator console where Radioso staff can see all orgs, their tiers and usage, create tiers, and change the tier per org — built on a proper staff principal with roles, not a role grafted onto a customer user."

## Overview

Radioso staff currently administer customer usage tiers only by sending raw
HTTP `PUT`s to `/api/v1/ee/usage-limits/*` authenticated by a single shared
`EE_USAGE_ADMIN_TOKEN`. That credential is an undifferentiated god-token: no
operator identity, no roles, no audit trail, and no UI. This feature introduces
a **staff-facing Operator Console** — a distinct surface on a distinct authority
axis from customer accounts — for administering customer **organizations** and
their **usage tiers**.

"Organization" in this spec maps to an `accounts` row; workspaces belong to an
account and usage limits are enforced per-account. An org is identified by
`accounts.id` and `accounts.name`. **Ownership is authoritative via
`account_memberships` (role `owner`) joined to `users.email`, not
`accounts.email`** — `accounts.email` is non-unique legacy/contact data and MUST
NOT be presented as the owner. An org may have multiple owners.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Staff signs in and reviews organizations, tiers, and usage (Priority: P1)

A Radioso staff member signs into the Operator Console through its own login
(separate from the customer dashboard) and sees a directory of every customer
organization with its currently-assigned tier and headline usage. They open one
org to see its full usage breakdown (monthly answers, stored documents, stored
indexed bytes, monthly indexed bytes — each against its limit). They can also
view the catalog of usage tiers (profiles) and their limits.

**Why this priority**: This is the foundation and the read-only MVP. It
establishes the staff principal + roles + separate session (the
expensive-to-retrofit authority model) and delivers immediate value: a
single place to see who is on what tier and how close they are to limits,
replacing blind raw `GET`s. No mutation, so it is safe to ship first.

**Independent Test**: Seed a staff user with a read-capable role and several
orgs on different tiers; sign in via the console login; assert the org list
shows each org with correct current tier and headline usage, the org detail
shows the full four-resource breakdown, and the tiers page lists all profiles.
A request without a valid staff session is rejected.

**Acceptance Scenarios**:

1. **Given** a valid staff session, **When** the operator opens the console home, **Then** they see a paginated, searchable list of all organizations, each with name, owner email, current tier (or "no tier"), and monthly-answers used/limit.
2. **Given** a valid staff session, **When** the operator opens an organization, **Then** they see its usage for all four metered resources against the assigned tier's limits, with "unlimited" shown where a limit is null.
3. **Given** a valid staff session, **When** the operator opens the tiers page, **Then** they see every usage tier with its display name and four limits.
4. **Given** no staff session (or only a customer session), **When** any console API is called, **Then** the request is rejected with 401 and no organization data is returned.

---

### User Story 2 - Operator changes an organization's tier (Priority: P1)

An operator with write authority selects a different tier for an organization
(or unassigns it), confirms the change showing current → target, and the new
tier takes effect immediately. The change is recorded as an audit event.

**Why this priority**: This is the core operational action the feature exists
to make safe and self-serve. It depends on US1's authority model and directory.

**Independent Test**: As a write-capable staff user, change org A from tier
`starter` to `growth`; assert the assignment is updated, subsequent usage reads
reflect the new limits, and an audit event records actor, org, from-tier,
to-tier, and timestamp. Unassigning clears the tier.

**Acceptance Scenarios**:

1. **Given** a write-capable operator viewing an org on tier `starter`, **When** they change it to `growth` and confirm, **Then** the org's assignment becomes `growth` and the detail view reflects `growth` limits.
2. **Given** an operator changes a tier, **When** the change succeeds, **Then** an audit event is persisted capturing actor staff id, organization id, previous tier, new tier, and timestamp.
3. **Given** an operator selects "no tier" / unassign and confirms, **Then** the org's assignment is cleared and enforcement falls back to no-tier behavior.
4. **Given** a read-only operator, **When** they attempt to change a tier, **Then** the action is unavailable in the UI and rejected by the API with 403.

---

### User Story 3 - Operator creates or edits a usage tier (Priority: P2)

An operator with write authority creates a new tier or edits an existing one,
setting a display name and the four limits (any of which may be unlimited).
Byte limits are entered in human units and stored as bytes. The change is
audited.

**Why this priority**: Needed to manage the tier catalog itself, but orgs can be
moved among existing tiers (US2) without it, so it ranks below US2.

**Independent Test**: Create tier `growth` with explicit limits; assert it
appears in the catalog and can be assigned in US2. Edit it; assert updated
limits apply to orgs already on it. Both actions produce audit events.

**Acceptance Scenarios**:

1. **Given** a write-capable operator, **When** they create a tier with a unique key, display name, and four limits, **Then** the tier appears in the catalog and is assignable.
2. **Given** an existing tier, **When** the operator edits its limits, **Then** the new limits govern enforcement for every org currently assigned to it.
3. **Given** a tier-limit byte field, **When** the operator enters a value in MB/GB, **Then** it is persisted as bytes and, on reload, re-displayed as a normalized human-readable unit (which may differ from the unit originally typed — e.g. 1024 MB may render as 1 GB), per FR-010.
4. **Given** any tier create/edit, **When** it succeeds, **Then** an audit event records the actor, tier key, and the changed fields.

---

### User Story 4 - Role-scoped operator authority (Priority: P2)

Staff identities carry roles that gate what they can do: a read-only role can
view everything but mutate nothing; a billing/write role can change tiers and
manage the tier catalog; an owner role can additionally manage staff identities
and roles.

**Why this priority**: The user explicitly chose to build the full staff
principal with roles now. Role enforcement is part of the authority model, but
it is separable from the read/write feature slices for testing.

**Independent Test**: For each role, attempt each console action; assert
allowed actions succeed and disallowed actions are rejected with 403 at the API
(not merely hidden in the UI). Owner can create another staff user and assign a
role; non-owner cannot.

**Acceptance Scenarios**:

1. **Given** a `support_read` operator, **When** they call any mutating console endpoint, **Then** it is rejected with 403.
2. **Given** a `billing_write` operator, **When** they change a tier or edit the catalog, **Then** it succeeds.
3. **Given** an `owner` operator, **When** they create a staff user and assign a role, **Then** the new staff user can sign in with exactly that role's authority.
4. **Given** a non-owner operator, **When** they attempt to manage staff identities, **Then** it is rejected with 403.
5. **Given** a fresh EE install with no staff identities, **When** the bootstrap path is invoked with a valid `EE_USAGE_ADMIN_TOKEN`, **Then** an `owner` staff identity is created (audited as actor "bootstrap") and can sign in; **and** invoking the same path with an invalid/absent token creates nothing.
6. **Given** an owner locked out of their credential, **When** the bootstrap path resets it with a valid `EE_USAGE_ADMIN_TOKEN`, **Then** the owner can sign in again and the reset is audited.

### Edge Cases

- What happens when an organization has **no tier assigned**? It appears in the directory as "no tier"; usage shows actuals with "unlimited" limits; enforcement uses no-tier behavior.
- What happens when a tier is **edited to lower a limit below an org's current usage**? The change is accepted; affected orgs are immediately over-limit and blocked on the next reservation. The console SHOULD surface which orgs would be over-limit before confirming a lowering edit, as a non-blocking warning (warn-only in v1; see FR-014).
- What happens when an operator tries to **delete a tier still assigned to orgs**? Out of v1 scope (no tier deletion in v1); if added, must be blocked or force-unassign with audit.
- What happens to the existing **`EE_USAGE_ADMIN_TOKEN`** path? It remains as a break-glass credential whose **only** purpose is bootstrap/recovery of staff `owner` identities (see FR-015); it is not the console's routine human auth, and the console UI uses staff sessions only.
- **First-owner bootstrap / lockout recovery** (resolved): a fresh EE install has no staff principal. A bootstrap endpoint (or CLI), gated solely by `EE_USAGE_ADMIN_TOKEN`, provisions an `owner` staff identity (create, or reset its credential if locked out). This is the chicken-and-egg break-glass: the env token mints the first owner; thereafter owners create staff via the console. The bootstrap action is audited (actor = "bootstrap").
- What happens when the org directory is **large**? The list endpoint MUST paginate and keep per-row usage cheap; full breakdowns load per-org on demand.
- Concurrent tier changes to the same org: last write wins; both are audited.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search. (This feature adds relational staff/audit tables only; no new vector usage.)
- LLM integrations MUST use the configured default provider. (This feature has no LLM usage; no conversational copy is generated.)
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings. (N/A — operator console is a staff tool, not a conversational surface; static operator-UI labels are acceptable and are not assistant copy.)
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic (limit/byte formatting, data adapters) rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated (e.g. staff session signing secret).
- Customer data MUST be protected with least-privilege access and secure transmission; the staff authority axis MUST be separate from customer/workspace authority and default-deny by role.
- Admin-facing pages MUST use the shared dark theme and existing design tokens (Radix/shadcn primitives, Lucide icons).
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - Transport: Express routers under the EE backend module (`/api/v1/ee/...`) own HTTP; the new operator-console frontend package owns rendering and submission.
  - Orchestration: a staff-auth guard/service mediates session → principal → role; the existing `EnterpriseUsageLimitService` orchestrates tier/usage operations.
  - Domain logic: usage-tier rules stay in the EE usage-limits module; staff identity/role rules live in a new staff-auth module beside it.
  - Persistence: new `ee_staff_*` tables and an operator audit table; existing `ee_usage_limit_*` tables unchanged.
- **Encapsulation Rule**:
  - `EnterpriseUsageLimitService` stays usage-tier-only; it MUST NOT learn about staff identity, sessions, or roles.
  - The operator-console frontend stays UI-only; it MUST NOT encode enforcement rules or talk to the DB.
  - The OSS core MUST remain free of any reference to the console, staff tables, or EE endpoints; only the existing `usageLimitPolicy` capability port crosses into OSS.
- **New Seams Required**:
  - A **staff principal + roles** module (identity, role, session issuer) in EE, exposing a `requireStaffSession`/`requireStaffRole` guard.
  - An **organization directory** read port/endpoint (`listOrganizations`) — the one genuinely missing query.
  - An **operator audit** sink for staff mutations (tier change, catalog edit, staff management).
  - A new EE **operator-console frontend package** with its own `feature-manifest.mjs` and route sync (mirroring `ee/packages/auth-frontend`).
- **Anti-Goals**:
  - Do NOT add a staff/operator role flag to the customer `accounts` or users tables.
  - Do NOT reuse the customer session cookie/issuer for staff auth.
  - Do NOT make `EE_USAGE_ADMIN_TOKEN` the console's human authentication.
  - Do NOT add staff-auth logic into `EnterpriseUsageLimitService` or the chat/retrieval stack.
  - Do NOT add OSS knowledge of EE staff concepts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a staff identity distinct from customer accounts/users, with one or more assignable roles (`support_read`, `billing_write`, `owner`).
- **FR-002**: System MUST authenticate operators through a console-owned login and session issuer separate from the customer session, and MUST reject customer sessions and the absence of a staff session on all console endpoints.
- **FR-003**: System MUST enforce role authorization at the API layer (default-deny): read for all roles; tier change and catalog edit for `billing_write` and `owner`; staff management for `owner` only.
- **FR-004**: System MUST expose a paginated, searchable organization directory returning per-org: account id, name, **owner email(s) derived from `account_memberships` (role `owner`) joined to `users.email`** (not `accounts.email`), current tier key/display name (or none), and a cheap headline usage figure (monthly answers used/limit). Where an org has multiple owners, the directory MUST show the primary owner (earliest active `owner` membership) and indicate that additional owners exist; org detail MAY list all owners. An org with no active owner membership MUST render as "no owner" rather than falling back to `accounts.email`.
- **FR-005**: System MUST expose, per organization, the full usage breakdown for all four metered resources against the assigned tier's limits (reusing existing usage computation).
- **FR-006**: System MUST list all usage tiers with their display name and four limits.
- **FR-007**: Authorized operators MUST be able to create and edit usage tiers (display name + four nullable limits), with null meaning unlimited.
- **FR-008**: Authorized operators MUST be able to assign a tier to an organization or unassign it, taking effect immediately for enforcement.
- **FR-009**: System MUST persist an audit event for every operator mutation (tier assignment change, tier create/edit, staff identity/role change) capturing actor staff id, action, target identifier, before/after where applicable, and timestamp. Audit output MUST NOT contain secrets, password hashes, or customer document content.
- **FR-010**: System MUST accept byte limits from the UI in human units (e.g. MB/GB), convert to bytes, and store only the byte value (existing schema). On reload, the stored byte value MUST be displayed as a normalized human-readable unit (largest unit that represents it exactly, else a fixed precision). The system does NOT guarantee echoing the exact unit originally typed — display-unit metadata is intentionally not stored.
- **FR-011**: System MUST retain the `EE_USAGE_ADMIN_TOKEN` raw-API path as a break-glass credential whose sole sanctioned use is staff `owner` bootstrap/recovery (FR-015), independent of staff sessions.
- **FR-012**: `owner` operators MUST be able to create staff identities and assign/revoke their roles; non-owners MUST NOT.
- **FR-013**: The operator-console frontend MUST register via its own EE feature manifest and route sync, and MUST NOT be importable by or reachable from the OSS build.
- **FR-014**: System SHOULD surface, before confirming a tier-lowering catalog edit, which assigned organizations would become over-limit, as a non-blocking warning (warn-only in v1; the operator may proceed).
- **FR-015**: System MUST provide a bootstrap/recovery path, gated **solely** by `EE_USAGE_ADMIN_TOKEN`, that provisions an `owner` staff identity or resets a locked-out owner's credential. This MUST be the only way to mint the first owner, MUST be audited (actor = "bootstrap"), and MUST NOT be capable of any other console operation.

### Key Entities *(include if feature involves data)*

- **Staff User**: A Radioso operator identity, separate from customer `accounts`. Attributes: id, email/login identifier, credential, status (active/disabled), assigned role(s), timestamps.
- **Staff Role**: Named authority level (`support_read`, `billing_write`, `owner`) determining permitted console actions.
- **Staff Session**: An authenticated operator session minted by the console's own issuer; distinct from the customer session cookie.
- **Operator Audit Event**: A record of a staff mutation — actor staff id (or "bootstrap"), action type, target (org/tier/staff id), before/after summary, timestamp.
- **Owner Bootstrap/Recovery path**: A break-glass operation gated only by `EE_USAGE_ADMIN_TOKEN` that creates the first `owner` staff identity or resets a locked-out owner's credential; not a console-session action.
- **Organization Owner**: Derived, not stored on the org — `account_memberships` rows with role `owner` for the account, joined to `users.email`. An account may have zero or several owners; the directory shows the primary (earliest active) owner.
- **Usage Tier (Profile)** *(existing)*: `ee_usage_limit_profiles` — key, display name, four limits.
- **Organization Tier Assignment** *(existing)*: `ee_usage_limit_account_assignments` — account → profile key (one per org).
- **Organization** *(existing)*: `accounts` row; the unit a tier is assigned to and usage is measured for.

## Observability *(mandatory)*

This feature introduces new privileged runtime paths (staff authentication,
role-gated mutations, bootstrap) that warrant observability beyond the audit
trail. Per repo guidance, the explicit review:

- **Audit events** (system of record, FR-009/FR-015): every staff mutation —
  tier assignment change, tier create/edit, staff identity/role change, and
  bootstrap. Captures actor, action, target, before/after, timestamp.
- **Structured logs** (Pino): staff sign-in success/failure, session
  issuance/expiry, role-denied (403) decisions, and bootstrap invocations.
  Include staff id, action, target id, and outcome for support correlation.
- **Metrics** (low-cardinality counters): staff auth failures, role-denied
  attempts, tier changes, tier catalog edits, bootstrap invocations. Labeled by
  action/role/outcome only — never by org id, staff id, or email.
  *v1 status: deferred.* The Enterprise backend module exposes no metrics sink
  today; audit events + structured logs cover the operator-relevant signal.
  Adding a metrics-sink port is a separate infra change tracked as a follow-up.
  Staff-login rate-limiting is likewise deferred (a shared, backed limiter is
  the correct fix; `bcrypt` makes brute force slow in the interim).
- **Spans** (OpenTelemetry): console mutation endpoints participate in the
  existing request tracing; no new bespoke span taxonomy required for v1.
- **Privacy constraints**: observability output MUST NOT contain credentials,
  password hashes, session tokens, `EE_USAGE_ADMIN_TOKEN`, customer document
  content, or full email lists. Emails in logs are for support correlation only
  and stay out of metric labels.
- **Deliberately excluded**: per-org usage gauges as metrics (high cardinality;
  usage is read on demand from the DB), and read-path request logging beyond
  the platform default.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can find any organization and see its current tier and usage in under 30 seconds, without issuing a raw API call.
- **SC-002**: 100% of tier-change and tier-catalog mutations produce a correct audit event (actor, target, before/after, timestamp).
- **SC-003**: 100% of mutating console endpoints reject a `support_read` operator with 403 and accept a `billing_write`/`owner` operator, verified per endpoint.
- **SC-004**: No customer-session or unauthenticated request can read or mutate any console data (0 successful unauthorized requests in tests).
- **SC-005**: The OSS build contains zero references to the console, staff tables, or staff endpoints (architecture-boundary validation passes).
- **SC-006**: A tier change is reflected in the organization's enforced limits on the next metered operation (no stale-limit window beyond the assignment write).
- **SC-007**: The organization directory returns the first page in acceptable time at expected org counts, with per-row usage kept cheap (no full four-resource computation per row).
- **SC-008**: A fresh EE install can reach a signed-in `owner` using only `EE_USAGE_ADMIN_TOKEN`, and that token can perform no console operation other than owner bootstrap/recovery.
- **SC-009**: The org directory shows the membership-derived owner email (or "no owner") for 100% of rows and never falls back to `accounts.email`.
