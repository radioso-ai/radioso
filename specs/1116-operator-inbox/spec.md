# Feature Specification: Operator Inbox — Dedicated CX Surface for Reacting to Handoffs

**Feature Branch**: `1116-operator-inbox`
**Created**: 2026-08-28
**Status**: Draft
**Input**: GitHub issue #1116 and the product decision that the existing conversation drawer stays a builder/debugging surface while reaction work gets its own design: a two-pane inbox with an item lifecycle and a composer that claims the conversation implicitly.

## Problem

Activity today is a builder surface wearing an operator hat. Needs-attention items appear and vanish with no lifecycle, so a handled handoff leaves no record and two operators cannot see that one of them already dealt with it. The only reply path lives inside a drawer whose layout headlines Debug, Flow, and test chat, leads with a conversation UUID, offers no situation summary (although a rolling conversation summary is already persisted per conversation), and demands an explicit "Take over" ceremony before the operator can do the one thing they came to do. Radioso is a horizontal platform — operators are not living in this dashboard — so the moments they do react must be fast, legible, and leave a trace.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - React to a handoff end to end (Priority: P1)

As an operator, when a conversation is waiting for a human I can open it from the inbox, understand the situation without reading the full transcript, reply in one motion, and mark the item done — without ever touching a builder tool.

**Why this priority**: Reacting to handoffs is the core CX job the Activity section exists for; every other story refines it.

**Independent Test**: Trigger a handoff on a test agent, open the inbox, and complete read → reply → done entirely within the new surface; the visitor receives the reply on their channel.

**Acceptance Scenarios**:

1. **Given** a conversation awaiting a human, **When** the operator opens the Needs attention section, **Then** they see a two-pane page with the item in the left queue and, on selection, a response view on the right.
2. **Given** an open response view, **When** the operator reads the header, **Then** it identifies the visitor in words (verified name or anonymous label), the page the visitor is on as a full URL with tracking parameters stripped, how long the item has been waiting, and why the conversation was handed off — and never leads with a conversation identifier. The channel appears only when it adds information (for example Slack); the default web embed is not labeled.
3. **Given** a conversation with a stored rolling summary, **When** the response view opens, **Then** a situation card shows that summary; **Given** the summary is missing or expired, **Then** the card falls back to the visitor's first message without blocking the view.
4. **Given** an AI-owned conversation shown in the inbox, **When** the operator types into the always-visible composer and sends, **Then** the send claims the conversation for that operator and delivers the reply to the visitor's channel with no separate take-over step.
5. **Given** an operator who has handled the conversation, **When** they mark the item Done, **Then** the item leaves the open queue and the conversation returns to the agent — Done is the single wrap-up action; there is no separate hand-back control.
6. **Given** the visitor sends a new message while the response view is open, **When** the workspace realtime stream (or its polling fallback) delivers the change, **Then** the transcript updates without a manual refresh.

---

### User Story 2 - Handled items leave a record (Priority: P2)

As an operator, every inbox item has an open → done lifecycle, so handled work is visible afterward instead of evaporating, and the empty inbox shows what the agent and team accomplished rather than a dead end.

**Why this priority**: Without a durable lifecycle the inbox cannot support more than one operator, and the empty state undermines trust in the product's "guided autonomy" promise.

**Independent Test**: Resolve one item of each type (handoff, approval, negative feedback) and verify each appears in the recently-closed strip with who closed it and how, while the open queue and badge count drop accordingly.

**Acceptance Scenarios**:

1. **Given** a handoff item marked Done, **When** the inbox reloads later, **Then** a durable closure record shows when it was closed, by whom, and an optional reason — a handled handoff never silently vanishes.
2. **Given** a pending approval item, **When** the decision is made (from the response view or anywhere else), **Then** the item closes automatically with the decision as its outcome; approvals never require a separate Done step.
3. **Given** a negative-feedback item, **When** the operator resolves or dismisses it, **Then** the existing answer-triage lifecycle (states, reasons, audit) is reused — this feature adds no second triage model for feedback.
4. **Given** an empty open queue, **When** the operator visits the inbox, **Then** they see a confidence summary of recent agent activity (such as conversations handled without intervention) and the recently-closed strip, not a bare empty state.
5. **Given** multiple signals on one conversation (for example a handoff plus negative feedback), **When** the queue renders, **Then** the conversation appears as a single item with the most critical signal leading, consistent with today's dedup behavior.

---

### User Story 3 - Team awareness without an assignment model (Priority: P2)

As an operator on a team, I can see which open items a teammate has already taken and how many items are open overall, without any explicit assignment feature.

**Why this priority**: The minimum coordination signal that prevents double-handling; anything richer is helpdesk scope we deliberately refuse.

**Independent Test**: With two operator sessions, have one claim a conversation by replying and verify the other sees the taken-by marker and updated counts without manual refresh (within the realtime rollout, or on the next poll otherwise).

**Acceptance Scenarios**:

1. **Given** an operator sends a reply from the response view, **When** a teammate views the queue, **Then** the item shows it is taken by that operator, derived from existing conversation ownership — no new assignment state.
2. **Given** open inbox items exist, **When** any dashboard page is shown, **Then** the Activity navigation entry carries a count of open items.
3. **Given** another operator closes or claims an item, **When** the realtime stream delivers the change, **Then** the queue reflects it without yanking the item the viewing operator currently has open mid-edit.
4. **Given** two operators act on the same conversation concurrently, **When** the second action conflicts with the first (ownership version), **Then** the second operator gets a clear conflict state rather than a silent overwrite.

---

### User Story 4 - Builder and CX surfaces separate cleanly (Priority: P3)

As an agent builder, the conversation drawer remains my debugging surface — transcript, Debug, Flow, test chat, send-to-eval — and no longer carries operator reply actions; each surface links quietly to the other.

**Why this priority**: The persona split is the organizing decision of this feature, but shipping it last avoids removing the current reply path before the replacement exists.

**Independent Test**: Open the drawer from All activity and verify no take-over/reply/hand-back controls render; open the same conversation from the inbox response view via its debug link and verify the drawer opens with full builder tooling.

**Acceptance Scenarios**:

1. **Given** the conversation drawer opened from All activity or Quality, **When** it renders, **Then** the operator action bar (take over, reply, hand back, decision buttons) is absent.
2. **Given** a response view, **When** the operator follows its single "open in debug view" link, **Then** the builder drawer opens for the same conversation.
3. **Given** a pending decision on a conversation, **When** the drawer is open, **Then** the decision is visible as state but only actionable from the inbox response view.

### Edge Cases

- Handoff with no recorded reason (for example a takeover initiated manually rather than by the agent): the header omits the reason line rather than inventing one.
- The rolling summary expired (abandoned conversation) or covers fewer messages than exist: fall back to the visitor's first message; never block the response view on summary generation.
- The conversation is claimed or handed back by someone else while the operator is composing: composer submit surfaces the ownership conflict and preserves the drafted text.
- An approval is resolved elsewhere while its response view is open: the decision controls disable and the item moves to recently closed.
- Realtime rollout is off for the account: everything degrades to the existing jittered polling without feature loss.
- Narrow viewports: the two panes collapse to a list → detail navigation; no separate mobile design.
- A conversation reopens after Done (visitor writes again, agent hands off again): a new open item is created; the prior closure record is unchanged.
- Anonymous versus verified visitors: the header uses the verified customer identity when present, otherwise a consistent anonymous label — never a raw session or conversation id.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact. (Operator-facing dashboard chrome — labels, buttons, empty-state text — is application UI, not assistant copy.)
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: "What needs operator attention" becomes a backend domain concern with a single owner. Today the Needs-attention page assembles its list client-side from four queries while Ray's triage digest computes a richer version server-side; this feature introduces one shared attention/inbox domain service that both the new inbox endpoint and the Ray digest consume. The frontend stops merging attention sources.
- **Encapsulation Rule**: The conversation drawer remains a presentation-only builder surface. Handoff ownership rules stay in the handoff module; reply delivery stays behind the existing operator-reply service and channel delivery ports. The operator reply/decision UI logic currently in the drawer's action bar is extracted into shared components consumed by the response view — moved, not duplicated.
- **New Seams Required**: (1) attention/inbox domain service and its HTTP surface; (2) closure persistence for handoff items (approvals and feedback reuse their existing state); (3) the two-pane inbox page and response-view components; (4) a shared operator-composer component that encapsulates claim-on-send and conflict handling.
- **Anti-Goals**: No assignment model, tags, priorities, SLAs, or per-operator read/unread state — this is not a helpdesk. No new realtime mechanism; reuse the workspace invalidation contract and its polling fallback. No inbox logic in chat route handlers or inside the operatorCopilot module. No second triage lifecycle for feedback. No summary generation on the read path.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The backend MUST expose the operator inbox as a single assembled list (handoffs, pending approvals, negative feedback), replacing client-side merging, with the same item set and dedup semantics the current page provides as the floor.
- **FR-002**: Every inbox item MUST have an open → closed lifecycle. Closing records when, by whom, and how (replied, handed back, decision taken, feedback resolved/dismissed, or dismissed with optional reason).
- **FR-003**: Handoff items MUST gain durable closure records; approval items MUST close automatically when their decision resolves; negative-feedback items MUST reuse the existing assistant-answer triage lifecycle unchanged.
- **FR-004**: The Needs attention section MUST render as a two-pane page: open-item queue (critical items first, oldest-waiting on top) with a collapsed recently-closed strip on the left, response view on the right.
- **FR-005**: Each queue row MUST show the item type, a one-line gist of what the visitor wants, waiting time (with the existing escalating urgency treatment), the time of the conversation's last message, and — when claimed — who has taken it.
- **FR-006**: The response-view header MUST be a single compact line: visitor identity (verified name or anonymous label), the visitor's page as a full URL with tracking parameters stripped, and waiting time. The channel MUST be labeled only when it is informative (non-default channels such as Slack); conversation identifiers MUST NOT lead the header.
- **FR-007**: The response view MUST show a situation card that leads with the handoff reason when one exists, followed by the stored rolling conversation summary, falling back to the visitor's first message when the summary is missing or expired.
- **FR-008**: The response view MUST render the transcript compactly with markdown rendered, newest message at the bottom, and live updates via the existing workspace event stream and polling fallback.
- **FR-009**: The composer MUST be always visible. Sending a reply MUST claim the conversation for the sender (implicit takeover) and deliver through the existing operator-reply path; there MUST be no separate take-over action on this surface.
- **FR-010**: Done MUST be the single wrap-up action: it closes the inbox item and returns the conversation to the agent (a no-op on ownership when the operator never claimed it, as for feedback items). There MUST NOT be a separate hand-back control on this surface; an operator who stops without finishing simply leaves, and the item stays open and marked as taken by them. The Done control MUST explain its effect (close and return to the agent) at the control itself — as a tooltip or equivalent — not as detached helper text.
- **FR-011**: Pending approval decisions MUST be actionable from the response view with the same option descriptions available today.
- **FR-012**: Ownership conflicts (another operator claimed, replied, or handed back concurrently) MUST surface as an explicit conflict state that preserves the operator's drafted text.
- **FR-013**: The Activity navigation entry MUST show the count of open inbox items.
- **FR-014**: The inbox empty state MUST summarize recent agent activity handled without intervention plus the recently-closed strip, and MUST retain a quiet link into the Quality review queue when untriaged quality items exist.
- **FR-015**: The conversation drawer MUST no longer render operator actions (take over, reply, hand back, decision buttons); the response view MUST link to the drawer ("open in debug view") and the drawer MUST NOT link builder tools into the response view.
- **FR-016**: Live updates MUST arrive without yanking the currently open item out from under the operator: list changes are reflected, but the selected response view changes only through explicit operator action or genuine conversation updates.
- **FR-017**: The queue MUST offer inbox-style filtering: a free-text search over item gists and visitor messages, plus dropdown selectors for item type (showing per-type open counts), agent, and taken state (anyone, unclaimed, a specific operator). Filters apply to the open queue and the recently-closed strip alike.

### Key Entities

- **Inbox item**: A derived unit of operator attention — type (handoff, approval, negative feedback), the conversation it points at, severity, waiting-since, taken-by (derived from conversation ownership), and lifecycle state. Assembled server-side; not a new copy of conversation state.
- **Inbox closure record**: The durable trace that a handoff item was closed — who, when, outcome, optional reason. Approvals and feedback derive closure from their existing records (decision resolution; answer triage).
- **Situation summary**: The existing per-conversation rolling summary, read-only on this surface, with the visitor's first message as fallback.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From an open inbox item to a sent reply takes three interactions (select item, type, send) with no surface or mode switch.
- **SC-002**: 100% of handled handoffs leave a visible record in recently closed; zero items disappear without a closure trace.
- **SC-003**: A teammate's claim or closure is visible to other operators without manual refresh — within seconds under the realtime rollout, and no later than the next poll cycle otherwise.
- **SC-004**: The builder drawer contains zero operator mutation actions and the response view contains zero builder tools, verified by end-to-end assertions on both surfaces.
- **SC-005**: For handoffs with a recorded reason and an available summary, the operator can state why the item needs them without opening the transcript — the response view presents reason and situation above the fold.
