# Feature Specification: Enterprise Human Contact Handoff

**Feature Branch**: `human-contact-intent`  
**Created**: 2026-05-04  
**Status**: Approved  
**Input**: User description: "Implement Enterprise-only human-in-the-loop contact handoff across dashboard chat, public chat, and website embed."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Request Human Follow-Up From Chat (Priority: P1)

An end user who cannot get a satisfactory assistant answer can request follow-up from a person without leaving the current chat surface.

**Why this priority**: This is the core user value. The feature is only useful if a user can turn an unresolved chat into a durable contact request.

**Independent Test**: Enable human contact for a workspace, ask for human follow-up from dashboard chat or public chat, complete the skill intake, and verify the system accepts the request while preserving the conversation reference.

**Acceptance Scenarios**:

1. **Given** human contact is enabled for a workspace, **When** the user asks for human follow-up, **Then** the chat skill intake collects the required contact email instead of falling through to retrieval.
2. **Given** the intake starts from an existing conversation, **When** the system prepares the request, **Then** the request message is derived from the conversation context unless the user has already provided one.
3. **Given** a user provides a valid email and message, **When** the request is durably stored, **Then** the user sees a received state that does not depend on immediate webhook delivery.
4. **Given** human contact is available, **When** the user repeats an explicit request while the intake is paused, **Then** the system re-prompts for the missing intake field.
5. **Given** a contact request has been submitted, **When** an operator opens Activity, **Then** the request appears as a Contact activity item with the submitter email, submitted message, delivery state, and linked conversation detail.

---

### User Story 2 - Configure Human Contact Delivery (Priority: P2)

An Enterprise workspace operator can enable or disable Talk to a human and configure email and/or webhook delivery.

**Why this priority**: Operators need explicit control over whether contact requests are available and where customer data is sent.

**Independent Test**: In an Enterprise build, save Talk to a human settings, configure email delivery, configure webhook delivery, reveal/copy/rotate the webhook signing token, and confirm disabled or incomplete settings hide the action and reject submissions.

**Acceptance Scenarios**:

1. **Given** an Enterprise operator opens channel settings, **When** they enable Talk to a human and configure a default email, **Then** requests can be delivered by email.
2. **Given** an Enterprise operator enables webhook delivery, **When** they save a webhook URL, **Then** the system generates a signing token that can be revealed, copied, hidden, and rotated.
3. **Given** Talk to a human is disabled or missing every required delivery configuration, **When** a user asks for human follow-up, **Then** the intake does not start and no request is stored.

---

### User Story 3 - Deliver Requests Reliably (Priority: P3)

An operator receives accepted contact requests through the configured webhook with signed payloads and automatic retries when delivery fails.

**Why this priority**: Durable delivery and retry make the handoff operationally reliable without blocking the user-facing chat flow.

**Independent Test**: Submit a contact request, run the delivery poller against mocked 2xx and failing webhook responses, and verify delivered, retry, and terminal failed states.

**Acceptance Scenarios**:

1. **Given** a stored pending contact request, **When** the webhook returns a success status, **Then** the request is marked delivered and the payload includes request, workspace, conversation, source, user email, message, trigger reason, and created timestamp.
2. **Given** a stored pending contact request, **When** the webhook fails with retryable responses, **Then** the system schedules exponential retry attempts up to the maximum.
3. **Given** a request reaches the retry limit, **When** the final attempt fails, **Then** the request is marked failed and the final delivery error is recorded without logging secrets.

### Edge Cases

- The intake prepares its request message from recent conversation context without exposing a separate editable composer.
- Public and embed users must provide an email address through the chat intake.
- Anonymous and public submissions reuse existing public chat session validation and rate limiting and add a stricter contact-request abuse limit.
- The LLM may classify intake intent or extract fields, but deterministic code owns validation, persistence, and delivery.
- The runtime must not lose a paused intake when the user repeats a contact request.
- The webhook payload must not include the full transcript in v1.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated for new configuration.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Shared backend contracts define the disabled OSS intake extension point; Enterprise backend modules own persistence, delivery, settings, and route implementation. Chat services only route intake results and must not deliver webhooks.
- **Encapsulation Rule**: `backend/src/app/http/routes/*` remain transport adapters. Existing assistant/public chat services must not absorb webhook delivery or persistence logic. Frontend chat components use normal chat messaging while the server-side intake owns collection.
- **New Seams Required**: Add a chat skill-intake provider plus a request repository, settings repository/service, submission service, webhook delivery service, and retry poller owned by the EE backend module.
- **Anti-Goals**: Do not implement OSS delivery. Do not include full transcripts in webhook payloads. Do not let LLM output submit a request automatically.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST expose a disabled-by-default core chat-intake extension point so OSS builds can compile with no Enterprise behavior.
- **FR-002**: Enterprise builds MUST register contact settings, skill intake, persistence, email delivery, webhook delivery, retry worker, and route implementations.
- **FR-003**: Chat responses MUST keep ordinary suggestions as send-message suggestions and MUST NOT use a contact-action payload for human handoff.
- **FR-004**: The system MUST start human-contact intake when human contact is enabled and the user explicitly asks for a person or follow-up.
- **FR-005**: The system MUST submit contact requests from the server-side intake flow for authenticated dashboard chat and public/embed chat.
- **FR-006**: The intake MUST use a conversation reference and optional assistant message reference to build the request message.
- **FR-007**: Request submission MUST validate conversation/session access, email, message, and trigger source, durably store the request, enqueue webhook delivery, and return an accepted intake result.
- **FR-008**: The system MUST persist request status, source channel and origin, account/workspace/conversation/message references, user email, user-edited message, trigger reason, attempts, next retry time, and final delivery error.
- **FR-009**: Webhook payloads MUST include request, account/workspace, conversation/message, source, submitted email/message, answer outcome or trigger reason, and created timestamp.
- **FR-010**: Webhook payloads MUST be signed with an HMAC header using an auto-generated workspace signing token that can be revealed, copied, hidden, and rotated.
- **FR-011**: Failed webhook delivery MUST retry with exponential backoff for up to 8 attempts and then mark the request terminal failed with redacted logging.
- **FR-012**: Enterprise settings UI MUST expose an enabled checkbox, an optional Email row with default recipient input, an optional Webhook row with URL input, reveal/copy/hide signing-token controls, and token rotation controls.
- **FR-013**: Dashboard, public chat, and website embed surfaces MUST rely on normal chat input for human-contact requests.
- **FR-014**: Disabled or incomplete human-contact settings MUST prevent the intake from starting and make internal submission return an explicit unavailable error.
- **FR-015**: Documentation MUST cover EE setup, settings, API shapes, webhook payloads, signing, retry behavior, and UI usage.
- **FR-016**: Dashboard, public chat, and website embed surfaces MUST route explicit typed contact requests through the human-contact skill intake when contact delivery is configured.
- **FR-017**: Activity MUST include Enterprise contact requests as first-class activity items and expose a detail view containing the submitted email, submitted message, delivery status, trigger metadata, and linked conversation transcript.

### UI Tasks

- Add server-side contact intake to authenticated chat, public chat, and embed chat.
- Add chat states for missing email, invalid email, submit failure, and received confirmation.
- Add Enterprise channel settings controls for enablement, webhook URL, masked secret, and rotation.
- Ensure contact handoff does not use chat suggestions as an execution transport.
- Ensure explicit typed contact requests use the same server-side intake across chat surfaces.
- Add Contact activity list rows, filter support, and a detail drawer panel linked to the source conversation.

### Key Entities

- **Human Contact Settings**: Per-workspace enablement and webhook delivery configuration, including masked secret state and retry metadata.
- **Human Contact Request**: A durable accepted request for human follow-up tied to account, workspace, conversation, optional assistant message, source, user email, message, trigger reason, status, attempts, retry time, and final error.
- **Webhook Delivery Attempt**: The current delivery state for a request, including attempt count, next retry time, and terminal outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, enabled Enterprise chat surfaces can submit a contact request through intake without waiting for webhook delivery.
- **SC-002**: In validation, disabled OSS/default behavior does not start contact intake and returns explicit unavailable errors for internal submit attempts.
- **SC-003**: In validation, email and webhook delivery reach delivered, retry scheduled, or terminal failed states deterministically, and webhook payloads are signed.
- **SC-004**: In validation, dashboard, public, and embed explicit typed contact requests complete through the chat intake instead of normal retrieval.
- **SC-005**: In validation, settings readback does not include the signing token, while the dedicated reveal action returns it and rotation replaces it.
- **SC-006**: In validation, submitted contact requests appear in Activity and the detail drawer shows the email, message, delivery state, and conversation transcript.
