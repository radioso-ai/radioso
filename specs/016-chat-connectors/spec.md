# Feature Specification: Chat Connector Plugin System

**Feature Branch**: `016-chat-connectors`
**Created**: 2026-03-18
**Status**: Draft
**Input**: User description: "Chat connector plugin system for workspace-scoped external chat connectors like WhatsApp"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enable a Chat Connector for a Workspace (Priority: P1)

A workspace administrator navigates to Settings and opens the "Chat Connectors" tab. They see a list of available connectors (e.g. WhatsApp, Telegram). Each connector shows its name, a short description, and whether it is currently enabled or disabled for this workspace. The administrator clicks on a disabled connector, fills in the required configuration fields (e.g. API token, phone number), and enables it. From that point, messages received through that channel are processed by the workspace's RAG pipeline and replies are sent back through the same channel.

**Why this priority**: This is the core value proposition — without the ability to configure and activate a connector, no external chat channel can function.

**Independent Test**: Can be fully tested by navigating to Settings > Chat Connectors, enabling a connector with valid credentials, and verifying the connector status changes to "enabled". Delivers the ability to connect an external messaging platform to a workspace.

**Acceptance Scenarios**:

1. **Given** a workspace with no connectors enabled, **When** the admin opens Settings > Chat Connectors, **Then** all available connectors are listed with a "disabled" status.
2. **Given** a disabled connector with required configuration fields, **When** the admin fills in all required fields and clicks "Enable", **Then** the connector status changes to "enabled" and the configuration is saved.
3. **Given** a connector with missing required fields, **When** the admin attempts to enable it, **Then** the system shows a validation error indicating which fields are missing.
4. **Given** an enabled connector, **When** the admin returns to the Chat Connectors tab later, **Then** the connector still shows as enabled with the saved configuration visible.

---

### User Story 2 - Receive and Respond to Messages via a Connector (Priority: P2)

An end user sends a message through an external channel (e.g. WhatsApp). The connector receives the incoming message via its webhook, maps the sender to the correct workspace, passes the message through the existing chat pipeline (retrieval + LLM), and sends the generated response back through the same channel. The conversation is persisted in the workspace's chat history.

**Why this priority**: This is the runtime behaviour that makes the connector useful. It depends on the connector being configured (P1) but delivers the actual chat-over-external-channel experience.

**Independent Test**: Can be tested by sending a message to the configured external channel endpoint (or simulating a webhook call) and verifying the response is returned through the same channel and appears in conversation history.

**Acceptance Scenarios**:

1. **Given** an enabled WhatsApp connector for a workspace, **When** an external user sends a message to the configured phone number, **Then** the system receives the message, retrieves relevant context from the workspace's documents, generates a response, and sends the reply back via WhatsApp.
2. **Given** an incoming message from an unknown sender, **When** the connector receives it, **Then** a new conversation is created in the workspace's chat history.
3. **Given** an ongoing conversation from a known sender, **When** the sender sends a follow-up message, **Then** the message is appended to the existing conversation and the response considers conversation history.
4. **Given** an enabled connector whose external API credentials have become invalid, **When** a message arrives, **Then** the system logs the error, does not crash, and the connector status reflects the issue.

---

### User Story 3 - Disable and Reconfigure a Connector (Priority: P3)

A workspace administrator disables an active connector. Incoming messages to that channel are no longer processed. The administrator can later re-enable it with the same or updated configuration. Past conversations from the connector remain in history.

**Why this priority**: Lifecycle management is important for production use but is lower priority than initial setup and message flow.

**Independent Test**: Can be tested by disabling an enabled connector, sending a message to the channel (verifying it is not processed), then re-enabling and confirming message flow resumes.

**Acceptance Scenarios**:

1. **Given** an enabled connector, **When** the admin clicks "Disable", **Then** the connector status changes to "disabled" and incoming messages are no longer processed.
2. **Given** a disabled connector that was previously enabled, **When** the admin re-enables it, **Then** the saved configuration is reused and message processing resumes.
3. **Given** a disabled connector, **When** the admin edits the configuration fields and re-enables, **Then** the new configuration is saved and used.
4. **Given** a connector that has been disabled, **When** the admin views chat history, **Then** past conversations from that connector are still visible.

---

### Edge Cases

- What happens when two workspaces configure the same external phone number/channel? The system must reject the configuration with a clear error, since one external identity can only map to one workspace.
- What happens when the external service webhook delivers a message but the workspace's chat pipeline fails (e.g. LLM timeout)? The connector should log the error and optionally send a fallback "sorry, try again" message.
- What happens when a connector plugin fails to initialize at startup? The system must log the error and continue starting — a broken connector must not prevent the core application from running.
- What happens when a connector's configuration contains an invalid secret (e.g. revoked API token)? The connector should surface an error status visible in the UI rather than silently failing.

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

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The connector plugin system introduces a new `connectors` module. Transport (webhook routes) is owned by each connector plugin. Orchestration (lifecycle, registration) is owned by the `ConnectorRegistry`. Domain logic (message mapping, channel-specific protocol) is owned by each connector plugin. Persistence (connector config, connector-specific tables) is owned by each connector plugin via namespaced tables. Core modules (`chat`, `retrieval`, `documents`) remain untouched.
- **Encapsulation Rule**: `ChatService` must remain the single entry point for generating answers — connectors call into it, they do not duplicate or bypass it. The Settings UI tab renders connector config generically from declared schemas; it must not contain connector-specific UI code. `dependencies.ts` wires the `ConnectorRegistry` but does not contain connector-specific logic. The route index (`routes/index.ts`) mounts the connector registry's router but does not know about individual connectors.
- **New Seams Required**: `ConnectorPlugin` interface (lifecycle contract for all connectors). `ConnectorRegistry` (discovers, migrates, initializes, shuts down plugins). `ConnectorContext` (scoped API surface passed to each plugin: database, logger, chatService, router). Per-connector config schema declaration (declarative field definitions rendered by the UI).
- **Anti-Goals**: Do not add connector-specific logic to `ChatService`, `ChatHistoryService`, or any retrieval module. Do not create connector-specific frontend components — the setup UI must be schema-driven and generic. Do not use dynamic `import()` or filesystem scanning for plugin discovery — register plugins explicitly. Do not store connector secrets in plaintext in the database without encryption.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a `ConnectorPlugin` interface that each connector implements, defining: unique id, display name, description, config schema declaration, lifecycle methods (migrate, initialize, shutdown), and per-workspace config get/save/status operations.
- **FR-002**: System MUST provide a `ConnectorRegistry` that manages the full lifecycle of registered plugins: running connector migrations after core migrations, initializing connectors at startup, mounting connector routes under a shared namespace, and shutting down connectors gracefully on app termination.
- **FR-003**: System MUST expose standardized REST endpoints for connector management: list all available connectors with their per-workspace status, get a connector's config schema and current workspace configuration, save connector configuration for a workspace, and enable/disable a connector for a workspace.
- **FR-004**: Each connector MUST declare its configuration fields as a typed schema (supporting text, secret, select, and toggle field types) so the frontend can render the setup form generically without connector-specific UI code.
- **FR-005**: Connector configuration MUST be scoped to a workspace — enabling a connector in one workspace must not affect other workspaces.
- **FR-006**: Connector database tables MUST be namespaced with a connector-specific prefix (e.g. `connector_whatsapp_*`) to avoid collisions with core tables and other connectors.
- **FR-007**: The Settings page in the frontend MUST include a new "Chat Connectors" tab that lists all available connectors with their status and allows enabling, disabling, and configuring each connector.
- **FR-008**: Secret configuration fields (e.g. API tokens) MUST be stored encrypted at rest and MUST be masked in API responses (only showing last 4 characters).
- **FR-009**: When a connector is enabled and receives an incoming message via its webhook, the system MUST route the message through the workspace's existing chat pipeline (`ChatService`) and return the response through the same external channel.
- **FR-010**: Conversations originating from a connector MUST be persisted in the workspace's chat history and MUST be identifiable by their source channel.
- **FR-011**: A failed or misconfigured connector MUST NOT prevent the core application from starting or affect other connectors.
- **FR-012**: System MUST prevent the same external channel identity (e.g. phone number) from being configured in multiple workspaces simultaneously.

### UI Tasks

- Add a "Chat Connectors" tab to the existing Settings page, accessible via tab navigation alongside existing settings sections.
- Display a list of available connectors as cards showing: connector name, description, and enabled/disabled status badge.
- Clicking a connector card opens its configuration panel showing: fields rendered from the connector's declared schema, an enable/disable toggle, and a save button.
- Secret fields display masked values (last 4 characters) when a value is already saved, with a "change" action to update.
- Show validation errors inline when required fields are missing on save/enable.
- Show connector error status (e.g. "invalid credentials") as a warning badge on the connector card.

### Key Entities

- **ConnectorPlugin**: A modular extension that bridges an external messaging platform with the core chat system. Identified by a unique id, exposes a display name, description, config schema, and lifecycle hooks.
- **ConnectorConfig**: The per-workspace configuration for a specific connector. Contains the field values declared by the connector's schema, the enabled/disabled state, and an optional error status. Scoped to one workspace.
- **ConnectorMessage**: An incoming or outgoing message relayed through a connector. Maps to an external sender identity, a workspace conversation, and the external channel's message identifiers.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A workspace administrator can enable and configure a new chat connector in under 2 minutes using the Settings UI.
- **SC-002**: An incoming message from an external channel receives a response through the same channel within the same latency envelope as the web chat interface (plus network round-trip to the external API).
- **SC-003**: Connector conversations appear in workspace chat history and are indistinguishable in quality from web-originated conversations.
- **SC-004**: A malfunctioning connector (bad credentials, external API down) does not degrade the core application or other connectors — the system continues operating normally.
- **SC-005**: Adding a new connector type requires only implementing the `ConnectorPlugin` interface and registering it — no changes to core modules, no connector-specific frontend code.

## Clarifications

### Session 2026-03-18

- Q: Should the WhatsApp connector verify the `X-Hub-Signature-256` HMAC header on every incoming webhook POST? → A: Yes — verify on every POST, reject with 401 if invalid. Add `app_secret` as a required secret config field.
- Q: Should conversations with a returning sender expire after inactivity or persist forever? → A: New conversation after configurable inactivity period (default: 24 hours). Old conversation remains in history.
- Q: How should rapid sequential messages from the same sender be handled? → A: Queue per sender with a short debounce window (default: 3 seconds). Buffer messages and process as a single combined input with one reply.
- Q: Should the message log have automatic retention cleanup? → A: Auto-delete message log entries older than 90 days. Chat history in core tables is unaffected.
- Q: Should the connector expose a health endpoint and/or structured logging for operational observability? → A: Structured logging only (no health endpoint). Operators use log aggregation to monitor.

## Assumptions

- The external messaging platforms (WhatsApp Business API, etc.) provide webhook-based message delivery and REST APIs for sending replies.
- Workspace administrators are responsible for obtaining API credentials from the external platform (e.g. Meta Business Suite for WhatsApp).
- The first connector implementation will be WhatsApp via the WhatsApp Business API, serving as the reference implementation for the plugin interface.
- Connector webhook endpoints will be publicly accessible (the deployment environment handles TLS termination and routing).
- Message rate limits are governed by the external platform's own limits, not by the connector system.

---

## Appendix A: WhatsApp Connector (Reference Implementation)

This appendix specifies the first connector plugin: WhatsApp via the Meta WhatsApp Business Cloud API. It serves as the reference implementation for the `ConnectorPlugin` interface.

### Overview

The WhatsApp connector uses Meta's Cloud API (Graph API-based) to receive incoming messages via webhooks and send replies via the Messages API. The On-Premises API was sunset in October 2025 — only the Cloud API is supported.

### Configuration Schema

The WhatsApp connector declares the following configuration fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `phone_number_id` | text | yes | The Phone Number ID from Meta Business Suite (not the phone number itself — this is the Graph API identifier). |
| `access_token` | secret | yes | A permanent System User access token with the `whatsapp_business_messaging` permission, generated in Meta Business Suite. |
| `webhook_verify_token` | secret | yes | A shared secret chosen by the admin, used by Meta to verify the webhook endpoint during initial subscription. |
| `app_secret` | secret | yes | The App Secret from the Meta App Dashboard, used to verify the `X-Hub-Signature-256` HMAC signature on incoming webhook payloads. |
| `business_account_id` | text | yes | The WhatsApp Business Account ID (WABA ID) that owns the phone number. |
| `conversation_timeout_hours` | text | no | Inactivity period (in hours) after which a returning sender starts a new conversation. Default: `24`. |

The connector auto-generates and displays (read-only) the webhook callback URL that the admin must register in the Meta App Dashboard. Format: `https://<host>/api/connectors/whatsapp/<workspace_id>/webhook`.

### Webhook Setup

1. **Verification (GET)**: When Meta subscribes to the webhook, it sends a GET request with `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`. The connector MUST validate that `hub.verify_token` matches the configured `webhook_verify_token` and respond with the `hub.challenge` value as plain text. If the token doesn't match, respond with 403.

2. **Notifications (POST)**: Incoming messages arrive as POST requests with a JSON payload structured as:
   - `object`: `"whatsapp_business_account"`
   - `entry[].changes[].value.messaging_product`: `"whatsapp"`
   - `entry[].changes[].value.metadata.phone_number_id`: identifies which phone number received the message
   - `entry[].changes[].value.contacts[].wa_id`: the sender's WhatsApp ID (phone number in international format)
   - `entry[].changes[].value.contacts[].profile.name`: the sender's display name
   - `entry[].changes[].value.messages[].id`: unique message ID (WAMID, up to 128 characters)
   - `entry[].changes[].value.messages[].from`: sender phone number
   - `entry[].changes[].value.messages[].timestamp`: Unix timestamp
   - `entry[].changes[].value.messages[].type`: message type (e.g. `"text"`, `"image"`, `"document"`)
   - `entry[].changes[].value.messages[].text.body`: the message text (when type is `"text"`)

3. **Signature Verification (POST)**: Every incoming webhook POST includes an `X-Hub-Signature-256` header containing an HMAC-SHA256 hash of the raw request body, keyed with the App Secret. The connector MUST compute the expected signature and compare it (using constant-time comparison) to the header value. If the signature is missing or invalid, the connector MUST reject the request with HTTP 401 and log the attempt. This prevents forged webhook calls from injecting fake messages.

4. **Acknowledgement**: The connector MUST respond to webhook POSTs with HTTP 200 within 5 seconds. Message processing (RAG pipeline, LLM generation) happens asynchronously after acknowledgement. Meta retries unacknowledged webhooks and may disable the subscription after repeated failures.

### Sending Replies

Replies are sent via POST to `https://graph.facebook.com/v21.0/<phone_number_id>/messages` with:
- Header: `Authorization: Bearer <access_token>`
- Body: `{ "messaging_product": "whatsapp", "to": "<recipient_wa_id>", "type": "text", "text": { "body": "<response_text>" } }`

The connector MUST handle API error responses (invalid token, rate limit, recipient not on WhatsApp) and surface them in the connector status.

### Message Type Handling

For the initial implementation:
- **Text messages**: Fully supported — passed through the chat pipeline and replied to with text.
- **Image, document, audio, video, location, contacts, stickers**: NOT supported in the initial implementation. The connector MUST reply with a polite fallback message (e.g. "Sorry, I can only process text messages at this time.") and NOT pass non-text messages to the chat pipeline.
- **Message status updates** (`statuses` field in webhook payload — sent, delivered, read): Logged but not surfaced to the user in the initial implementation. The connector MUST NOT treat status updates as incoming messages.
- **Reaction messages**: Ignored silently (no response, no error).

### Conversation Identity Mapping

- The sender's WhatsApp ID (`wa_id`, which is their phone number in international format like `14155551234`) serves as the external sender identity.
- Each unique `wa_id` maps to one **active** conversation per workspace. If the sender's last message in the active conversation is within the inactivity timeout, the conversation is continued. Otherwise, a new conversation is created. The previous conversation remains in chat history.
- The inactivity timeout is configurable per connector instance, defaulting to **24 hours**. This aligns with WhatsApp's own messaging window and provides a natural conversation boundary.
- The sender's profile name (from `contacts[].profile.name`) is stored and used as the display name in chat history.

### WhatsApp-Specific Database Tables

Tables are prefixed with `connector_whatsapp_`:

- **`connector_whatsapp_contacts`**: Maps WhatsApp sender identities to workspace conversations. Columns: `wa_id` (the sender's WhatsApp phone number), `profile_name`, `workspace_id`, `conversation_id` (FK to core conversations table), `first_seen_at`, `last_message_at`.
- **`connector_whatsapp_message_log`**: Audit log of all inbound and outbound messages for debugging and retry. Columns: `wamid` (WhatsApp message ID, unique), `direction` (inbound/outbound), `workspace_id`, `wa_id`, `message_type`, `payload` (full JSON payload for inbound, request body for outbound), `status` (received, processing, replied, failed), `error_details`, `created_at`. Entries older than 90 days are automatically deleted. Chat history in core tables is unaffected by this cleanup.

### WhatsApp-Specific Edge Cases

- **Duplicate webhooks**: Meta may deliver the same webhook notification more than once. The connector MUST deduplicate using the `wamid` — if a message ID has already been processed, it is acknowledged (200) but not re-processed.
- **WhatsApp 24-hour messaging window**: WhatsApp only allows businesses to send free-form messages within 24 hours of the customer's last message. If the chat pipeline takes longer than expected or the user re-engages after 24h, the reply will fail. The connector MUST log this and update the message status to `failed` with a clear error. The initial implementation does NOT send template messages to reopen the window.
- **Rate limiting**: The Cloud API enforces per-phone-number rate limits (varies by tier: 250, 1K, 10K, 100K messages/day). The connector MUST handle 429 responses with exponential backoff and log rate limit errors in the message log.
- **Access token expiry**: If using a short-lived token (not recommended), API calls will start failing. The connector MUST detect 401 responses, update the connector status to an error state visible in the UI, and stop attempting to send until credentials are updated.
- **Phone number registered elsewhere**: If the configured phone number is already registered to another WhatsApp Business Account, the Cloud API calls will fail. This is an external configuration issue — the connector surfaces the API error in its status.

### WhatsApp Connector Functional Requirements

- **WA-001**: The WhatsApp connector MUST implement the webhook verification handshake (GET with `hub.verify_token` and `hub.challenge`) as required by the Meta App Dashboard webhook subscription flow.
- **WA-002**: The WhatsApp connector MUST acknowledge all incoming webhook POST requests with HTTP 200 within 5 seconds and process messages asynchronously.
- **WA-003**: The WhatsApp connector MUST deduplicate incoming messages by `wamid` to handle Meta's at-least-once delivery guarantee.
- **WA-004**: The WhatsApp connector MUST only process messages of type `"text"` and reply to unsupported types with a user-friendly fallback message.
- **WA-005**: The WhatsApp connector MUST silently ignore webhook payloads that contain only message status updates (`statuses`) or reactions, without treating them as incoming messages.
- **WA-006**: The WhatsApp connector MUST map each unique sender `wa_id` to a persistent conversation in the workspace, creating a new conversation on first contact and continuing the existing one on subsequent messages.
- **WA-007**: The WhatsApp connector MUST log all inbound and outbound messages in the `connector_whatsapp_message_log` table with their processing status and any error details.
- **WA-008**: The WhatsApp connector MUST handle Cloud API error responses (401, 429, 400) by updating the message log status and, for persistent auth errors, updating the connector status to an error state visible in the Settings UI.
- **WA-009**: The WhatsApp connector MUST verify the `X-Hub-Signature-256` HMAC-SHA256 signature on every incoming webhook POST using the configured `app_secret`, rejecting requests with invalid or missing signatures with HTTP 401.
- **WA-010**: The WhatsApp connector MUST create a new conversation when a sender's last message in the active conversation is older than the configured `conversation_timeout_hours` (default: 24 hours). The previous conversation MUST remain in chat history.
- **WA-011**: The WhatsApp connector MUST debounce rapid sequential messages from the same sender — buffering messages for a short window (default: 3 seconds after the last received message) and then processing all buffered messages as a single combined input, producing one reply. This prevents out-of-order responses and gives the LLM full context of multi-message input.
- **WA-012**: The WhatsApp connector MUST automatically delete `connector_whatsapp_message_log` entries older than 90 days. This cleanup MUST NOT affect conversations stored in core chat history tables.
- **WA-013**: The WhatsApp connector MUST emit structured log events (using the application's existing logger) for the following operations: webhook received, signature verification failed, message processing started, reply sent successfully, reply failed. Each log event MUST include `workspace_id`, `wa_id`, and `wamid` where applicable.
