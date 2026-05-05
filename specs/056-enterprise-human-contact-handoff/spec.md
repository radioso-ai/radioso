# Feature Specification: Enterprise Human Contact Handoff

**Feature Branch**: `human-contact-intent`  
**Created**: 2026-05-04  
**Status**: Approved  
**Input**: User description: "Implement Enterprise-only human-in-the-loop contact handoff across dashboard chat, public chat, and website embed."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Request Human Follow-Up From Chat (Priority: P1)

An end user who cannot get a satisfactory assistant answer can request follow-up from a person without leaving the current chat surface.

**Why this priority**: This is the core user value. The feature is only useful if a user can turn an unresolved chat into a durable contact request.

**Independent Test**: Enable human contact for a workspace, trigger the action from dashboard chat or public chat, submit the inline handoff composer, and verify the system accepts the request while preserving the conversation reference.

**Acceptance Scenarios**:

1. **Given** human contact is enabled for a workspace, **When** a chat response includes a human-contact action, **Then** selecting that action replaces the chat input with an inline contact form instead of sending another chat message.
2. **Given** the inline composer opens from an existing conversation, **When** the system can prepare the form, **Then** the form is prefilled with an editable message based on the latest user issue.
3. **Given** a user submits a valid email and message, **When** the request is durably stored, **Then** the user sees a received state that does not depend on immediate webhook delivery.
4. **Given** human contact is currently available in the visible chat UI, **When** the user types an explicit request to contact a person, **Then** the system enacts the handoff intent by opening the inline composer instead of producing a normal assistant answer that contradicts the displayed option.
5. **Given** a contact request has been submitted, **When** an operator opens Activity, **Then** the request appears as a Contact activity item with the submitter email, submitted message, delivery state, and linked conversation detail.

---

### User Story 2 - Configure Human Contact Delivery (Priority: P2)

An Enterprise workspace operator can enable or disable Talk to a human and configure email and/or webhook delivery.

**Why this priority**: Operators need explicit control over whether contact requests are available and where customer data is sent.

**Independent Test**: In an Enterprise build, save Talk to a human settings, configure email delivery, configure webhook delivery, reveal/copy/rotate the webhook signing token, and confirm disabled or incomplete settings hide the action and reject submissions.

**Acceptance Scenarios**:

1. **Given** an Enterprise operator opens channel settings, **When** they enable Talk to a human and configure a default email, **Then** requests can be delivered by email.
2. **Given** an Enterprise operator enables webhook delivery, **When** they save a webhook URL, **Then** the system generates a signing token that can be revealed, copied, hidden, and rotated.
3. **Given** Talk to a human is disabled or missing every required delivery configuration, **When** a user tries to submit a request, **Then** the API returns an explicit unavailable error and no action is advertised in chat.

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

- The inline composer prepares its editable message without an LLM-generated auto-summary.
- If an authenticated user has an email address, the dashboard composer defaults to that address; public and embed users must enter an email address.
- Anonymous and public submissions reuse existing public chat session validation and rate limiting and add a stricter contact-request abuse limit.
- The LLM may suggest a human-contact action, but it never submits a request or decides delivery.
- The runtime must not tell users human contact is unavailable when the current chat surface is already displaying the option.
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

- **Boundary Rule**: Shared backend contracts define the disabled OSS extension point; Enterprise backend modules own persistence, delivery, settings, and route implementation. Chat services only decide when to advertise an action and must not deliver webhooks.
- **Encapsulation Rule**: `backend/src/app/http/routes/*` remain transport adapters. Existing assistant/public chat services must not absorb webhook delivery or persistence logic. Frontend chat components own presentation and inline composer state, while API-client code owns HTTP calls.
- **New Seams Required**: Add a generic OSS chat-action provider interface plus a request repository, settings repository/service, draft service, submission service, webhook delivery service, and retry poller owned by the EE backend module.
- **Anti-Goals**: Do not implement OSS delivery. Do not include full transcripts in webhook payloads. Do not let LLM output submit a request automatically.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST expose a disabled-by-default core chat-action extension point so OSS builds can compile and return explicit unavailable behavior.
- **FR-002**: Enterprise builds MUST register contact settings, draft, submit, persistence, email delivery, webhook delivery, retry worker, route implementations, and the contact-specific chat action provider.
- **FR-003**: Chat responses MUST allow suggestions to carry an action kind named `contact_human`, while existing suggestion behavior remains send-message based.
- **FR-004**: The system MUST advertise or enact a human-contact action when human contact is enabled and deterministic failure conditions occur, when the user explicitly asks for a person, or when a bounded LLM classifier recommends escalation.
- **FR-005**: The system MUST provide draft and submit APIs for authenticated dashboard chat and public/embed chat.
- **FR-006**: The draft API MUST take a conversation reference and optional assistant message reference and return an editable draft message without generating an internal summary.
- **FR-007**: The submit API MUST validate conversation/session access, email, message, and trigger source, durably store the request, enqueue webhook delivery, and return `202 Accepted` with a request identifier.
- **FR-008**: The system MUST persist request status, source channel and origin, account/workspace/conversation/message references, user email, user-edited message, trigger reason, attempts, next retry time, and final delivery error.
- **FR-009**: Webhook payloads MUST include request, account/workspace, conversation/message, source, submitted email/message, answer outcome or trigger reason, and created timestamp.
- **FR-010**: Webhook payloads MUST be signed with an HMAC header using an auto-generated workspace signing token that can be revealed, copied, hidden, and rotated.
- **FR-011**: Failed webhook delivery MUST retry with exponential backoff for up to 8 attempts and then mark the request terminal failed with redacted logging.
- **FR-012**: Enterprise settings UI MUST expose an enabled checkbox, an optional Email row with default recipient input, an optional Webhook row with URL input, reveal/copy/hide signing-token controls, and token rotation controls.
- **FR-013**: Dashboard, public chat, and website embed surfaces MUST show the manual entry point when enabled and handle action suggestions by opening an inline composer in the chat input area.
- **FR-014**: Disabled or incomplete human-contact settings MUST hide actions and make draft or submit endpoints return an explicit unavailable error.
- **FR-015**: Documentation MUST cover EE setup, settings, API shapes, webhook payloads, signing, retry behavior, and UI usage.
- **FR-016**: Dashboard, public chat, and website embed surfaces MUST treat explicit typed contact requests as `contact_human` intent only when the contact action is available in the currently rendered chat state.
- **FR-017**: Activity MUST include Enterprise contact requests as first-class activity items and expose a detail view containing the submitted email, submitted message, delivery status, trigger metadata, and linked conversation transcript.

### UI Tasks

- Add an inline contact-human composer to authenticated chat, public chat, and embed chat.
- Add form states for loading draft, editable email, editable message, validation errors, submit in progress, submit failure, and received confirmation.
- Add Enterprise channel settings controls for enablement, webhook URL, masked secret, and rotation.
- Ensure action suggestions do not appear or behave like normal message suggestions.
- Ensure explicit typed contact requests use the same inline composer when the contact action is visible.
- Add Contact activity list rows, filter support, and a detail drawer panel linked to the source conversation.

### Key Entities

- **Human Contact Settings**: Per-workspace enablement and webhook delivery configuration, including masked secret state and retry metadata.
- **Human Contact Request**: A durable accepted request for human follow-up tied to account, workspace, conversation, optional assistant message, source, user email, message, trigger reason, status, attempts, retry time, and final error.
- **Webhook Delivery Attempt**: The current delivery state for a request, including attempt count, next retry time, and terminal outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, enabled Enterprise chat surfaces can submit a contact request and receive a `202` request identifier without waiting for webhook delivery.
- **SC-002**: In validation, disabled OSS/default behavior hides contact actions and returns explicit unavailable errors for direct submit attempts.
- **SC-003**: In validation, email and webhook delivery reach delivered, retry scheduled, or terminal failed states deterministically, and webhook payloads are signed.
- **SC-004**: In validation, dashboard, public, and embed action suggestions and visible explicit typed contact requests open the inline composer instead of sending a chat message.
- **SC-005**: In validation, settings readback does not include the signing token, while the dedicated reveal action returns it and rotation replaces it.
- **SC-006**: In validation, submitted contact requests appear in Activity and the detail drawer shows the email, message, delivery state, and conversation transcript.
