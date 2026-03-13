# Data Model: Modular RAG Backend

## Account

- **Purpose**: Owns all tenant-scoped resources
- **Fields**:
  - `id` UUID, primary key
  - `email` unique, normalized lowercase
  - `password_hash`
  - `created_at`
  - `updated_at`
- **Relationships**:
  - one-to-many with `Session`
  - one-to-one with `AccountToken`
  - one-to-one with `RetrievalSettings`
  - one-to-many with `Document`
  - one-to-many with `Conversation`

## Session

- **Purpose**: Represents an authenticated browser/session context for login-bound actions
- **Fields**:
  - `id` UUID, primary key
  - `account_id` FK
  - `session_token_hash`
  - `created_at`
  - `expires_at`
  - `last_seen_at`
  - `revoked_at` nullable
- **Validation**:
  - token hash required
  - `expires_at` must be later than `created_at`
- **State transitions**:
  - `active` -> `expired`
  - `active` -> `revoked`

## AccountToken

- **Purpose**: Bearer token used by document and chat APIs
- **Fields**:
  - `account_id` PK/FK
  - `token_prefix`
  - `token_hash`
  - `created_at`
  - `last_used_at` nullable
- **Validation**:
  - exactly one row per account
  - prefix must match emitted token family such as `sk_proj_`

## RetrievalSettings

- **Purpose**: Configures optional retrieval behavior per account
- **Fields**:
  - `account_id` PK/FK
  - `query_rewrite_enabled` boolean
  - `rerank_enabled` boolean
  - `vector_top_k` integer
  - `similarity_threshold` numeric
  - `rerank_top_k` integer
  - `created_at`
  - `updated_at`
- **Validation**:
  - `vector_top_k` between 1 and 300
  - `similarity_threshold` between 0 and 1
  - `rerank_top_k` positive

## Document

- **Purpose**: Stores canonicalized source content for an account
- **Fields**:
  - `id` UUID, primary key
  - `account_id` FK
  - `title`
  - `source_content`
  - `markdown_content`
  - `status`
  - `created_at`
  - `updated_at`
  - `failed_at` nullable
  - `failure_reason` nullable
- **Validation**:
  - title required
  - source content required
- **State transitions**:
  - `received` -> `normalized`
  - `normalized` -> `chunked`
  - `chunked` -> `embedded`
  - `embedded` -> `ready`
  - any active state -> `failed`

## Chunk

- **Purpose**: Retrieval unit derived from a document
- **Fields**:
  - `id` UUID, primary key
  - `document_id` FK
  - `account_id` FK
  - `chunk_index`
  - `content`
  - `token_count` nullable
  - `embedding` vector
  - `start_offset` nullable
  - `end_offset` nullable
  - `created_at`
- **Validation**:
  - `chunk_index` unique per document
  - non-empty content

## Conversation

- **Purpose**: Server-stored chat thread
- **Fields**:
  - `id` UUID, primary key
  - `account_id` FK
  - `created_at`
  - `updated_at`
- **Validation**:
  - conversation belongs to exactly one account

## Message

- **Purpose**: Ordered conversation history entries
- **Fields**:
  - `id` UUID, primary key
  - `conversation_id` FK
  - `account_id` FK
  - `role` enum (`user`, `assistant`, `system`)
  - `content`
  - `created_at`
- **Validation**:
  - role restricted to supported set
  - content required

## AuditEvent

- **Purpose**: Tracks security-sensitive and operationally important actions
- **Fields**:
  - `id` UUID, primary key
  - `account_id` nullable FK
  - `event_type`
  - `event_status`
  - `metadata_json`
  - `created_at`
- **Validation**:
  - no raw secrets stored in metadata

## Relationships Summary

- `Account` 1 -> many `Session`
- `Account` 1 -> 1 `AccountToken`
- `Account` 1 -> 1 `RetrievalSettings`
- `Account` 1 -> many `Document`
- `Account` 1 -> many `Conversation`
- `Document` 1 -> many `Chunk`
- `Conversation` 1 -> many `Message`

## Derived Read Models

- **RetrievedContextSet**: in-memory projection joining selected `Chunk`
  content with source `Document` metadata for prompt assembly
- **ChatExecutionContext**: in-memory projection of `Conversation` history plus
  current account retrieval settings for one chat request
