# Feature Specification: Slack as a document source (save a Slack message as a document by asking the agent)

**Feature Branch**: `096-slack-document-source` (to be created)  
**Created**: 2026-06-23  
**Status**: Draft — DEFERRED (separate from Spec 095 by owner decision)  
**Input**: User description: "A new way to add a document in the menu — Slack. When enabled, the Radioso LLM reads requests and complies, e.g. '@radioso save this document as our refund policy.' Can be a separate feature if too big for one spec."

> Carved out of the broader Slack request (see Spec 095 and `.context/slack-full-experience-design.md`). This is **LLM-interpreted ingestion**, a different concern from operator actions, so it ships separately. Builds on Spec 092 (Slack channel, `app_mention` already handled) and the document ingestion pipeline.

## Framing

Today an `@radioso …` mention in Slack always means "ask the agent." This feature adds a second meaning, **enabled deliberately as a document source**: when an operator says, in natural language, "@radioso save this as our refund policy," the agent recognizes a *save-as-document* intent (via the LLM, not keyword lists — Radioso is multilingual), captures the referenced message/thread, and ingests it as a curated document with the operator-supplied title.

Surfacing: in the dashboard's **Add a document** menu, "Slack" becomes a source option (alongside upload / website / etc.). Enabling it turns on the in-Slack save behavior for the bound workspace and explains the gesture. Ingestion reuses `documentIngestionService.ingest()` with a Slack connector source and an idempotent external id, so re-saving the same message is a no-op.

**Why separate from Spec 095**: 095 is operator *actions* on conversations (approve/handoff/talk) through the HITL domain; this is *knowledge ingestion* through the documents domain, with an LLM intent classifier. Different domains, different risk profile (writes to the knowledge base), different review surface.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Save a message as a titled document by asking the agent (Priority: P1)

With "Slack" enabled as a document source, an operator (a workspace member) replies in a Slack thread "@radioso save this as our refund policy." The agent recognizes the save intent and the title, captures the parent/threaded message content, ingests it as a document titled "Refund policy" in the workspace's knowledge, and confirms in-thread with a link to the document. Asking again is idempotent. A plain question ("@radioso what's our refund policy?") still gets a normal grounded answer — not a save.

**Why this priority**: It is the whole feature. It proves LLM intent disambiguation (save vs. ask), content capture, titled ingestion, idempotency, and authorization in one slice.

**Independent Test**: With Slack source enabled and a stubbed Slack Web API + LLM: deliver an `app_mention` whose text expresses a save intent with a title; assert the LLM classifier returns `save_document` + extracted title, the referenced message/thread is fetched, a document is ingested with that title and a Slack connector source + idempotent `externalDocumentId`, and an in-thread confirmation with the document link is posted. Deliver a save mention again → assert no duplicate document. Deliver a normal question mention → assert a grounded answer, no ingestion. Deliver a save mention from a non-member → assert it is refused (no ingestion).

**Acceptance Scenarios**:

1. **Given** Slack source enabled, **When** a member asks the agent to save a message as "<title>", **Then** the referenced content is ingested as a document titled "<title>" and an in-thread confirmation with a link is posted.
2. **Given** the same message saved before, **When** asked again, **Then** no duplicate document is created (idempotent by Slack message ref).
3. **Given** a normal question mention, **When** received, **Then** the agent answers as usual and ingests nothing.
4. **Given** Slack source disabled, **When** a save-style mention arrives, **Then** the agent does not ingest (and either answers normally or explains the source is off).
5. **Given** a non-member or unauthorized user, **When** they ask to save, **Then** ingestion is refused.

### Edge Cases

- Ambiguous intent (could be a question or a save) → LLM classifier must choose confidently; when unsure, ask a brief clarifying question rather than silently ingesting.
- No title supplied → derive a sensible title (LLM) or prompt for one; never ingest an untitled blob silently.
- Long threads → define what content is captured (the referenced message vs. the whole thread); confirm scope.
- Empty/attachment-only messages, or messages the bot can't read (missing scope/not in channel) → clear in-thread error, no partial document.
- Idempotency across edits: re-saving an edited message → decide update-in-place vs. new revision.

## Constitution Constraints *(mandatory)*

- No implementation before approval. Backend Node.js/TDD; PostgreSQL unchanged.
- Intent classification MUST be LLM-driven (structured enum + extracted title), never English keyword/verb lists — multilingual.
- LLM prompt template lives under `backend/prompts/`.
- Reuses existing document ingestion; no new storage system.
- New Slack read scopes (`channels:history`, `groups:history`, and per capture-scope decision) in `.env.example`; re-consent surfaced. No secrets in UI/logs.
- Docs updated (Add-a-document Slack source; `docs/slack-channel.md`).

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Slack connector (transport) captures content and calls the documents domain; an LLM **intent classifier** (prompt-returned enum + title) decides save-vs-ask; `documentIngestionService` (domain) owns ingestion. Slack does not own document rules; documents do not own Slack.
- **New Seams**: a save-intent classifier (prompt + typed result) on the mention path; a Slack→document capture adapter; a "Slack" entry in the Add-a-document source registry with an enable toggle bound to the workspace's Slack install.
- **Anti-Goals**: no keyword parsing for intent; no Slack history as an always-on knowledge dump (this is explicit, per-message, operator-initiated save); do not duplicate ingestion logic.

## Requirements *(mandatory)*

- **FR-001**: "Slack" MUST appear as an enable-able source in Add-a-document, bound to the workspace's Slack install; disabled by default.
- **FR-002**: On an `app_mention`, an LLM classifier MUST decide `ask` vs `save_document` and, for save, extract a title — no keyword lists.
- **FR-003**: For a `save_document` intent from an authorized member, the system MUST capture the referenced message/thread content and ingest it via `documentIngestionService` with the extracted title, a Slack connector source, and an idempotent `externalDocumentId` (`slack:{team}:{ts}`).
- **FR-004**: Re-saving the same message MUST be idempotent (no duplicate document).
- **FR-005**: The agent MUST post an in-thread confirmation with a link to the saved document, or a clear error if capture/ingestion fails.
- **FR-006**: Unauthorized users / disabled source MUST NOT cause ingestion.
- **FR-007**: New scopes/re-consent in manifest + `.env.example`; ingestion audit records the Slack source and operator; no raw content in logs.

## Success Criteria *(mandatory)*

- **SC-001**: A member can save a Slack message as a titled document by asking, and find it in the knowledge base, without leaving Slack.
- **SC-002**: Save vs. ask intent is classified correctly in the target languages (no keyword lists), with ambiguous cases asking rather than mis-saving.
- **SC-003**: Re-saving the same message creates zero duplicates.
- **SC-004**: With the source disabled, no Slack message is ever ingested.
