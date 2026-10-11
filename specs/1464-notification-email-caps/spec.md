# Feature Specification: Notification Email Caps And Hygiene

**Feature Branch**: `fix/notification-email-caps-1464`

**Created**: 2026-10-11

**Status**: Approved

**Input**: GitHub issue #1464, slice 1: cap outbound contact and notice volume and harden recipient authoring, visitor content, reply-to headers, email classification, and webhook authenticity.

## User Scenarios & Testing

### User Story 1 - Bound Outbound Volume (Priority: P1)

As an operator or host, I need one workspace or conversation to have a finite notification-email blast radius so abuse cannot damage the shared sender.

**Why this priority**: Unbounded outbound volume is the direct spam-relay risk.

**Independent Test**: Repeatedly dispatch contact and routine-ending notices, then verify unique requests stop sending at the conversation cap and email fan-out stops at the workspace's daily plan cap while retries retain the first decision.

**Acceptance Scenarios**:

1. **Given** a workspace below its daily allowance, **when** a contact or operator notice sends to configured email recipients, **then** the email attempts are admitted and counted once.
2. **Given** a workspace at its daily allowance, **when** another delivery requests email recipients, **then** no email is attempted, any independently configured webhook may still run, and an operator-visible low-cardinality outcome identifies the daily cap.
3. **Given** a conversation at its dispatch allowance, **when** another contact or notify request is drained, **then** neither its email nor contact/notice webhook is attempted and the outcome identifies the conversation cap.
4. **Given** a previously admitted or skipped outbox request, **when** it is retried, **then** it receives the same decision without consuming the limits again.

---

### User Story 2 - Restrict And Audit Recipients (Priority: P1)

As a workspace owner, I need only owners and administrators to change notification recipient lists, and I need those changes recorded without exposing addresses in operational output.

**Why this priority**: Recipient authoring is the control that turns ordinary conversation traffic into delivery to arbitrary third parties.

**Independent Test**: Attempt agent and notify-skill recipient changes as member, admin, and owner identities over REST and operator tooling, then inspect audit records for safe counts and hashes.

**Acceptance Scenarios**:

1. **Given** a member who can otherwise manage agents, **when** they create or update an agent or notify skill with recipient-list changes, **then** the change is refused.
2. **Given** an owner or administrator, **when** they change a recipient list, **then** the change succeeds and one audit event records previous/new counts and irreversible address hashes, not raw addresses.
3. **Given** a member changing unrelated agent or skill configuration, **when** no recipient list changes, **then** existing authoring permissions continue to apply.
4. **Given** an operator tool proposal that changes recipients, **when** it is applied, **then** the same elevated permission is required as on the HTTP endpoint; drafting the proposal does not mutate recipients.

---

### User Story 3 - Sanitize Delivery Inputs (Priority: P1)

As an email recipient or webhook consumer, I need visitor-controlled content bounded and webhook calls authenticated so a visitor cannot create oversized mail or spoof a Radioso delivery.

**Why this priority**: Input and authenticity gaps amplify the relay risk even after volume is bounded.

**Independent Test**: Dispatch oversized contact and routine values, invalid reply-to values, and contact/notice webhooks; verify bounded bodies, absent invalid reply-to headers, stable email-kind tags, and valid signature headers.

**Acceptance Scenarios**:

1. **Given** oversized visitor contact name/message or routine string slots, **when** a notification email is rendered, **then** visitor-supplied values are truncated to documented bounds before entering the email body.
2. **Given** an invalid visitor-supplied reply-to value, **when** an email sends, **then** no reply-to header is set.
3. **Given** a contact or notice email, **when** it reaches the mail transport, **then** it carries a stable email-kind classification.
4. **Given** a configured contact or notice webhook, **when** Radioso posts it, **then** it includes the existing timestamp, idempotency, and HMAC signature headers.

### Edge Cases

- A fan-out that would cross the remaining daily allowance is skipped as one unit rather than partially delivered.
- A webhook-only dispatch consumes the conversation dispatch allowance but no daily email units.
- A cap decision remains stable across worker retries and concurrent drainers.
- Missing workspace or conversation context fails closed when the delivery guard is active.
- Invalid reply-to content may remain bounded body text but never becomes a mail header.
- Recipient hashes are normalized so address casing does not create misleading audit differences.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST enforce a per-workspace UTC-day cap on provider attempts for contact and operator-notification email, counting each recipient as one email.
- **FR-002**: Enterprise plan records MUST define the daily notification-email allowance; self-hosted operation MUST resolve a finite default through the same usage-limit policy boundary without importing enterprise code.
- **FR-003**: The system MUST enforce at most five unique contact/notify dispatches per conversation.
- **FR-004**: Cap decisions MUST be concurrency-safe and idempotent for one outbox request.
- **FR-005**: A cap skip MUST persist a bounded outcome/reason and emit an audit or equivalent operator-visible event containing no recipient address.
- **FR-006**: Contact and notice email MUST carry distinct stable email-kind classifications.
- **FR-007**: Only effective workspace owners and administrators, including equivalent machine principals, MAY change agent or notify-skill recipient lists.
- **FR-008**: Successful recipient-list changes MUST be audited with previous/new counts and irreversible normalized-address hashes, never raw addresses.
- **FR-009**: Contact names MUST be bounded to 200 characters, contact messages to 4,000 characters, and visitor-supplied string slot values to 1,000 characters before email bodies are built.
- **FR-010**: Visitor-supplied reply-to values MUST be syntactically valid email addresses of at most 320 characters before use as an email reply-to header or webhook reply-to field.
- **FR-011**: Contact and operator-notice webhooks MUST use the existing signed-webhook header format.
- **FR-012**: REST, Ray, and Operator MCP mutations MUST apply the same conditional recipient-list restriction.
- **FR-013**: Product documentation MUST describe caps, elevated recipient authoring, truncation, and webhook signature verification.
- **FR-014**: This slice MUST NOT implement recipient confirmation state or provider bounce/complaint suppression.

### Key Entities

- **Notification Delivery Outcome**: One idempotent decision for an outbox request, scoped to a workspace/day and optionally a conversation, recording requested/reserved email counts, limits, and a bounded outcome.
- **Plan Notification Allowance**: The finite number of contact/notice recipient emails one workspace may attempt per UTC day under a plan.
- **Recipient Change Audit**: A safe record of the authored resource, previous/new counts, and normalized address hashes.

## Success Criteria

### Measurable Outcomes

- **SC-001**: In concurrent tests, a workspace never reserves more notification emails in one UTC day than its resolved allowance.
- **SC-002**: No conversation admits more than five unique contact/notify dispatches.
- **SC-003**: Every cap skip is queryable by one of two stable reasons and no cap log, metric, or audit event contains `@`-bearing recipient data.
- **SC-004**: Member recipient mutations fail across HTTP and operator-tool paths while unrelated member authoring remains available.
- **SC-005**: All delivered contact/notice messages remain within the published visitor-text bounds and invalid reply-to input never reaches an email header.
- **SC-006**: Every contact/notice webhook request can be verified using the documented HMAC algorithm.

## Assumptions

- The UTC day is the shared accounting window for deterministic multi-region behavior.
- The OSS/self-hosted daily default is 100 recipient emails; plan allowances are 100 for Comet, 1,000 for Satellite, and 5,000 for Planet.
- The configured contact/notice webhook URL remains the shared secret, as in the existing URL-as-secret contract; its exact configured string is used as the HMAC secret.
- An admitted provider attempt consumes capacity even when the provider later fails, avoiding ambiguous accepts and retry-based amplification.
- Recipient confirmation, confirmation-state display, existing-recipient grandfathering, and Resend bounce/complaint suppression are follow-up scope.
