# Feature Specification: Explicit consent before a sensitive slot

**Feature Branch**: `cairo-v1/1544-check`

**Created**: 2026-11-10

**Status**: Approved 2026-11-10 for planning and implementation.

**Input**: Issue #1544, part of the GDPR and Article 9 epic #1539. Builds on sensitive slots (#1543), the erasure port (#1540), workspace retention (#1541), and the one-person export (#1542).

## Context

Article 9(2)(a) lets a controller process special-category data (health, beliefs, sex life, and the rest) on the data subject's explicit consent. Article 4(11) asks for a clear affirmative act. Article 7(1) puts the burden of proof on the controller. Radioso operators collect such data in routines today through sensitive slots, and nothing asks for consent or records it.

## Clarifications

### Session 2026-11-10

- Q: Does consent need a button? → A: No. The visitor consents with a button where the channel shows one, or in writing. A written statement is the EDPB's standard example of explicit consent. A model reads a written reply into `granted`, `declined`, or `unclear`. Only an unambiguous agreement to the wording just shown is `granted`. A button click skips the model.
- Q: Which channels ask? → A: Web chat, the website embed, email, WhatsApp, and Slack. Voice does not ask, because a transcript is weak proof and Radioso keeps no audio. A routine on voice takes its decline path when it reaches a consent.
- Q: Where is consent authored? → A: On the routine, not as a step. A consent names the sensitive slots it covers. Radioso asks immediately before the step that collects the first covered slot, so a consent cannot be put in the wrong place.
- Q: What happens to messages when consent is withdrawn? → A: The values are erased. The messages that carried them stay, marked withheld, the way sensitive transcript text is withheld today.
- Q: Is the consent record erased with the conversation? → A: No. A minimal proof record stays: decision, wording version, language, channel, timestamps, and any withdrawal. It holds no slot values and no reply text. It is kept to defend legal claims (Article 17(3)(e)).

### Plan review 2026-11-10

- Q: Can a declined `continue` consent always skip asking? → A: Only if the collecting step collects nothing but covered fields and has a default exit. Validation enforces both for `continue` consents.
- Q: Can a covered field be corrected after the routine ends? → A: No. A correction never writes a covered field.
- Q: What does the agent say to an unclear reply? → A: An answer drawn only from the shown wording, followed by the verbatim wording and labels again. The first ask is verbatim only.
- Q: Which channels besides voice skip the ask? → A: Calling-agent channels (MCP, agent API, A2A), because a calling agent cannot give a person's consent. Test Chat and the REST assistant API ask with buttons.
- Q: How far does a decision reach? → A: The routine and consent key, across every language variant of that consent in the conversation's revision.
- Q: What identifies a record after erasure? → A: Its conversation and visitor ids stay as plain ids. Only the link to the carrying message is dropped.
- Q: Can Ray write consent wording? → A: No. Ray proposes only wording the operator supplied, verbatim.
- Q: What does "withheld" mean on withdrawal? → A: The message stays in the conversation, its text is replaced by the redaction marker, and it is marked withheld. Copies the email channel holds are withheld the same way. Text already delivered to Slack or WhatsApp stays with those providers, and the docs say so.

### End-to-end review 2026-11-11

- Q: What happens to a covered value the visitor stated before or with the grant? → A: Option A. It is never kept on the turn the grant arrives, since consent is recorded before anything is captured. From the next turn on, the collecting step may take the value from anything the visitor said earlier in the conversation, the grant message and messages from before the consent included, so it confirms or completes the value rather than losing it. A plain "no, nothing else" after an earlier statement yields the earlier value, not the refusal text. Only covered slots whose consent was granted before the turn, and only on a conversation that asks.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author a consent (Priority: P1)

An operator marks a routine slot as sensitive. Publishing fails until the routine has a consent that covers the slot. The operator writes the consent wording in the agent's default language and, optionally, in other languages, with a label for agreeing and a label for declining, and chooses what happens on decline: continue without the slot, or hand off to a person.

**Why this priority**: Without an authored consent nothing can be asked, and without the publish check a sensitive slot can still go out unasked.

**Independent Test**: Validate and publish routines with and without a covering consent through the API, Ray, and the routine editor.

**Acceptance Scenarios**:

1. **Given** a routine with a sensitive slot and no consent covering it, **When** the operator validates or publishes it, **Then** validation fails with a diagnostic naming the slot.
2. **Given** a consent that names a slot the routine does not have, or a slot that is not sensitive, **When** the operator validates, **Then** validation fails naming that slot.
3. **Given** a slot covered by two consents, **When** the operator validates, **Then** validation fails naming the slot.
4. **Given** a consent without wording in the agent's default language, or with empty wording or labels, **When** the operator validates, **Then** validation fails naming the consent and the field.
5. **Given** a valid consent, **When** the operator publishes, **Then** the routine publishes, and Ray and the operator MCP can read and edit the consent like any other routine field.

---

### User Story 2 - A visitor agrees on the web (Priority: P1)

A visitor on the web chat or the website embed reaches the step that collects a covered slot. Before that step, the agent shows the operator's consent wording word for word, with the two authored labels as buttons. The visitor clicks agree, and the routine continues and collects the slot.

**Why this priority**: The web is where most sensitive routines run, and the button is the clearest proof.

**Independent Test**: Playwright: run a routine with a covered sensitive slot in the embed, agree, and check that the slot is collected and the record exists.

**Acceptance Scenarios**:

1. **Given** a routine reaching the step that collects a covered slot, **When** the consent has not been decided in this conversation, **Then** the agent sends the wording exactly as authored in the visitor's language, without generated text around it, followed by the two labels as buttons.
2. **Given** the consent is shown, **When** the visitor clicks agree, **Then** a `granted` record is stored and the routine continues to the collecting step.
3. **Given** the consent is shown, **When** the visitor types a reply instead of clicking, **Then** the reply is read as in User Story 3.
4. **Given** a consent granted earlier in the same conversation with the same wording version, **When** the routine reaches another step it covers, or runs again, **Then** it is not asked again.

---

### User Story 3 - A visitor agrees in writing (Priority: P1)

A visitor on email, WhatsApp, or Slack, or one typing on the web, receives the consent wording with the two labels as plain text and answers in their own words.

**Why this priority**: Without it, text channels could not collect sensitive slots at all.

**Independent Test**: Scenario tests with the real mini model on agree, decline, and ambiguous replies in two languages; the record stores the decision and which message carried it.

**Acceptance Scenarios**:

1. **Given** the consent is shown, **When** the visitor replies with a clear agreement in any language, **Then** a `granted` record is stored and the routine continues.
2. **Given** the consent is shown, **When** the visitor replies with a clear refusal, **Then** a `declined` record is stored and the decline path runs.
3. **Given** the consent is shown, **When** the reply is ambiguous ("ok", "what do you do with it?", or an agreement with a condition), **Then** nothing is recorded, the agent answers what it can, and asks again.
4. **Given** the consent has been asked twice without a clear answer, **When** the next reply is still unclear, **Then** a `declined` record is stored and the decline path runs.
5. **Given** a reply that agrees and also contains a covered value ("yes, I'm pregnant"), **When** consent is recorded, **Then** the slot is not filled on that turn. From the next turn on, the collecting step may take the value from that message or any earlier one, so it confirms or completes the value rather than losing it.

---

### User Story 4 - A visitor declines (Priority: P1)

**Why this priority**: Consent is only freely given if declining has a real, authored outcome.

**Acceptance Scenarios**:

1. **Given** a consent whose decline choice is continue, **When** the visitor declines, **Then** the routine runs without the covered slots: their collecting steps do not ask for them, and the slots read as absent to guards.
2. **Given** a consent whose decline choice is hand off, **When** the visitor declines, **Then** the routine ends with a handoff, and the operator notice says the visitor declined consent without carrying any covered value.
3. **Given** a voice conversation, **When** the routine reaches a consent, **Then** the consent is not asked, no record is stored, and the decline path runs.

---

### User Story 5 - An operator records a withdrawal (Priority: P2)

A visitor asks the operator to withdraw their consent. The operator opens the conversation and withdraws it.

**Why this priority**: Article 7(3) makes withdrawal a right, but it is an operator action on a request, so it follows the consent itself.

**Independent Test**: Withdraw a granted consent through the API and the conversation view; the covered values are gone from the routine state, their messages read as withheld, and the record shows the withdrawal.

**Acceptance Scenarios**:

1. **Given** a granted consent, **When** the operator withdraws it, **Then** the values of the covered slots are erased from the routine state, the messages that carried them are marked withheld, and the record gains a withdrawal time and the acting member.
2. **Given** a routine still running in that conversation, **When** consent is withdrawn, **Then** the routine does not use the erased values and does not ask for consent again in that conversation.
3. **Given** a declined or already withdrawn consent, **When** the operator tries to withdraw it, **Then** nothing changes and the response says why.

---

### User Story 6 - Proof in the export (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a data subject with consent records, **When** the operator exports their data (#1542), **Then** the export lists each record with the wording shown, its version and language, the decision, the channel, and the decision and withdrawal times.
2. **Given** a conversation erased through #1540, **When** the erasure finishes, **Then** its consent records remain, without the link to the message that carried the decision.

### Edge Cases

- The visitor's language has no variant: the wording falls back the way Exact Words does (exact tag, then base language, then the agent's default language).
- The operator edits the wording after a visitor agreed: the record still points at the wording that visitor saw. A later conversation is asked with the new wording.
- A visitor typed a covered value before the routine reached its consent: the slot is still collected only after a grant. From the turn after the grant, the collecting step may take the value from that earlier message, and a reply that adds nothing ("no, nothing else") keeps it.
- A routine has sensitive slots and was published before this feature: it keeps serving as published. Its next publish needs a consent.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A routine definition MAY declare consents. Each consent has a stable key, the sensitive slots it covers, wording variants per language (body, agree label, decline label), and a decline choice: `continue` or `handoff`.
- **FR-002**: Validation MUST fail when a sensitive slot is covered by no consent or by more than one, when a consent covers an unknown or non-sensitive slot, or when a consent lacks a default-language variant or has empty text. Every surface that validates or publishes a routine uses this rule.
- **FR-003**: Radioso MUST ask a consent immediately before the first step that collects one of its covered slots, unless a decision for that consent and wording version already exists in the conversation.
- **FR-004**: The consent text MUST be the authored wording, sent verbatim. Application code and prompts MUST NOT add consent copy.
- **FR-005**: Where the channel renders buttons, the two labels MUST be offered as buttons whose click is delivered as a structured decision bound to the wording version shown, not as text.
- **FR-006**: A typed reply MUST be read by the model into `granted`, `declined`, or `unclear`. Only an unambiguous agreement to the shown wording is `granted`. `unclear` asks again; after two asks, the next unclear reply counts as `declined`.
- **FR-007**: A covered slot MUST NOT be filled before a grant, nor on the turn that carried the grant. From the next turn on, its collecting step MAY take the value from anything the visitor stated earlier in the conversation, the grant message included.
- **FR-008**: On decline, the routine MUST follow the consent's decline choice. Covered slots stay absent.
- **FR-009**: Voice conversations MUST NOT ask for consent, and MUST follow the decline choice.
- **FR-010**: Each decision MUST be stored as a record: workspace, agent, conversation, visitor, routine, consent key, wording version, language, decision, method (`button` or `reply`), channel, the message that carried it, and the decision time.
- **FR-011**: Every wording version shown MUST be stored immutably, so a record can always reproduce the exact text the visitor saw.
- **FR-012**: An operator MUST be able to withdraw a granted consent through the API and the conversation view. Withdrawal erases the covered values, replaces the text of the messages that carried them with the redaction marker and marks them withheld (the email channel's copies included), and stores the withdrawal time and the acting member on the record.
- **FR-013**: Consent records MUST appear in the one-person export.
- **FR-014**: Conversation and visitor erasure MUST keep the consent record and drop its link to the carrying message. Workspace deletion and workspace retention (#1541) MUST remove consent records and wording versions like any other conversation data.
- **FR-015**: Ray and the operator MCP MUST read and edit consents, surface the new validation diagnostics, and offer the withdrawal action, or the coverage map MUST state why not.
- **FR-016**: The OpenAPI contract and the TypeScript SDK snapshot MUST be updated, and the docs MUST cover authoring a consent, what visitors see per channel, withdrawal, and the record.

### Key Entities

- **Consent**: authored on a routine. Key, covered slots, wording variants, decline choice.
- **Consent wording version**: an immutable copy of one variant as shown, identified by its content.
- **Consent record**: one decision by one visitor in one conversation, with its optional withdrawal.

## Observability

- Structured log events when a consent is shown, decided, defaulted to declined after unclear replies, skipped on voice, and withdrawn. Fields: workspace, agent, conversation, routine, consent key, wording version, decision, method, channel. Never the wording, the reply, or slot values.
- Withdrawal writes an audit event (actor, conversation, consent key), never content.

## Success Criteria *(mandatory)*

- **SC-001**: No published routine collects a sensitive slot without a covering consent.
- **SC-002**: Every collected sensitive value has a `granted`, unwithdrawn consent record in its conversation.
- **SC-003**: In the scenario suite, no ambiguous or refusing reply is recorded as `granted`.
- **SC-004**: Every record reproduces the exact wording the visitor saw, before and after the conversation's erasure.

## Assumptions

- Proof records follow workspace retention (#1541) from their decision time. With no retention set, they live as long as the workspace.
- A decision covers the rest of the conversation for the same consent key and wording version.
- Free-text special-category data typed outside a routine is out of scope; it belongs to the special-category workspace mode (#1546).

## Out of Scope

- Consent on voice.
- A signed consent link for channels without buttons.
- Consent for purposes other than collecting a routine's sensitive slots.
