# Data Model: Chat Connector Plugin System

**Feature**: 016-chat-connectors | **Date**: 2026-03-18

## Core Entities

### ConnectorConfig

Per-workspace configuration for a connector plugin.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, generated | Row identifier |
| workspace_id | UUID | FK → workspaces.id, NOT NULL | Owning workspace |
| connector_id | VARCHAR(64) | NOT NULL | Plugin identifier (e.g. `whatsapp`) |
| enabled | BOOLEAN | NOT NULL, DEFAULT false | Whether the connector is active |
| config_data | JSONB | NOT NULL, DEFAULT '{}' | Configuration fields (secret values encrypted) |
| error_status | TEXT | nullable | Current error message if connector is unhealthy |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Row creation time |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Last modification time |

**Unique constraint**: `(workspace_id, connector_id)` — one config per connector per workspace.

**Validation rules**:
- `connector_id` must match a registered plugin id in the `ConnectorRegistry`.
- `config_data` must satisfy the plugin's declared config schema (all required fields present, correct types) before `enabled` can be set to `true`.
- Secret fields in `config_data` are stored as `iv:ciphertext:authTag` (base64). When read via API, secrets are masked to last 4 characters.

---

### ConnectorMigration

Tracks which plugin migrations have been applied (idempotency).

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | SERIAL | PK | Row identifier |
| connector_id | VARCHAR(64) | NOT NULL | Plugin identifier |
| migration_name | VARCHAR(255) | NOT NULL | Migration file name |
| applied_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | When migration was applied |

**Unique constraint**: `(connector_id, migration_name)`.

---

## WhatsApp Connector Entities

### connector_whatsapp_contacts

Maps WhatsApp sender identities to workspace conversations.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, generated | Row identifier |
| wa_id | VARCHAR(32) | NOT NULL | Sender's WhatsApp ID (international phone format) |
| profile_name | VARCHAR(255) | nullable | Sender's WhatsApp display name |
| workspace_id | UUID | FK → workspaces.id, NOT NULL | Workspace this contact belongs to |
| conversation_id | UUID | FK → conversations.id, NOT NULL | Active conversation for this sender |
| first_seen_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | When sender first messaged |
| last_message_at | TIMESTAMPTZ | NOT NULL | Timestamp of sender's most recent message |

**Unique constraint**: `(workspace_id, wa_id)` — one active contact record per sender per workspace.

**Lifecycle**:
- Created on first inbound message from a new sender.
- `last_message_at` updated on each inbound message.
- When `last_message_at` is older than the configured `conversation_timeout_hours` (default 24h) and a new message arrives, a new conversation is created and `conversation_id` is updated to point to it.
- `profile_name` updated if it changes between messages.

---

### connector_whatsapp_message_log

Audit log of all inbound and outbound WhatsApp messages.

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | UUID | PK, generated | Row identifier |
| wamid | VARCHAR(128) | UNIQUE, NOT NULL | WhatsApp message ID (used for deduplication) |
| direction | VARCHAR(8) | NOT NULL, CHECK (direction IN ('inbound', 'outbound')) | Message direction |
| workspace_id | UUID | FK → workspaces.id, NOT NULL | Associated workspace |
| wa_id | VARCHAR(32) | NOT NULL | Sender (inbound) or recipient (outbound) WhatsApp ID |
| message_type | VARCHAR(32) | NOT NULL | WhatsApp message type (text, image, etc.) |
| payload | JSONB | NOT NULL | Full webhook JSON (inbound) or request body (outbound) |
| status | VARCHAR(16) | NOT NULL, CHECK (status IN ('received', 'processing', 'replied', 'failed')) | Processing status |
| error_details | TEXT | nullable | Error message if status is 'failed' |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Row creation time |

**Retention**: Rows older than 90 days are automatically deleted. This does not affect conversations in the core `messages` table.

**Deduplication**: On inbound webhook, check if `wamid` already exists. If so, acknowledge with 200 but skip processing.

**Indexes**:
- `(workspace_id, wa_id, created_at DESC)` — lookup recent messages by sender.
- `(created_at)` — support retention cleanup queries.
- `(wamid)` — unique index for deduplication lookups.

---

## Entity Relationships

```
workspaces (existing)
  │
  ├──< connector_configs          (1:N — one per connector per workspace)
  │       └── connector_id → registered plugin in ConnectorRegistry (application-level)
  │
  ├──< connector_whatsapp_contacts (1:N — one per sender per workspace)
  │       └──> conversations (existing) (N:1 — active conversation)
  │
  └──< connector_whatsapp_message_log (1:N — audit trail)

conversations (existing)
  │
  └──< messages (existing)         (1:N — chat messages from all sources)
```

Connectors create conversations and messages in the existing core tables via `ChatService`. The connector-specific tables (`connector_whatsapp_*`) track external identities and provide an audit log — they do not duplicate chat content.

---

## State Transitions

### ConnectorConfig.enabled

```
disabled ──[admin enables + valid config]──> enabled
enabled  ──[admin disables]──────────────> disabled
enabled  ──[runtime error detected]──────> enabled (error_status set)
enabled  ──[admin fixes config]──────────> enabled (error_status cleared)
```

### connector_whatsapp_message_log.status

```
received ──[debounce fires, processing starts]──> processing
processing ──[ChatService returns, reply sent]──> replied
processing ──[any error]────────────────────────> failed
received ──[duplicate wamid detected]───────────> (no transition, row already exists)
```
