# Feature Specification: Exact Words

**Feature Branch**: `custom-greeting-action-chips`

**Created**: 2026-09-14

**Amended**: 2026-09-14 — review pass; see the checklist notes for what changed and why.

**Status**: Approved 2026-09-14 for planning and implementation (Slice A first).

**Input**: User request: “ok, let's spec out ‘exact words’.” Prior discussion calls for runtime-enforced authored wording shared by greetings, replies, directives, and routines, with multilingual variants and suggestion chips. Proactive communication is a separate capability.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Publish an opening with exact wording (Priority: P1)

An operator selects Exact words for the agent's greeting, writes the welcome message in the agent's default language, previews it, and publishes it. Visitors receive that wording even when the agent's general instructions ask for a different tone or wording.

**Why this priority**: The opening is the concrete customer need that motivated this feature and proves the exact-output guarantee without requiring response matching.

**Independent Test**: Configure, preview, and publish a custom greeting; open fresh web-chat and website-widget conversations and compare their greeting content with the published text.

**Acceptance Scenarios**:

1. **Given** an automatic greeting, **When** the operator selects Exact words and saves authored text, **Then** it is saved in the agent draft and previewable without changing the published greeting.
2. **Given** a published exact greeting, **When** a new conversation opens, **Then** the assistant emits the selected text with the same words, punctuation, capitalization, and line breaks, without generated introductions, closings, citations, or rewriting.
3. **Given** exact greeting text that conflicts with the agent's greeting instruction, **When** the greeting is presented, **Then** the greeting instruction does not modify that text.
4. **Given** the existing Automatic or Off greeting behavior, **When** the feature is installed or the operator switches back to that mode, **Then** its existing behavior remains intact; saved exact content is retained for later editing.
5. **Given** empty or whitespace-only text in a required variant, **When** the operator attempts to publish it, **Then** publication is rejected with the affected field identified.
6. **Given** a published exact greeting and an unavailable message-generation provider, **When** a new conversation opens, **Then** the greeting is still delivered.

---

### User Story 2 - Deliver a routine reply exactly (Priority: P1)

An operator selects Exact words on a routine step that speaks to the visitor. The routine still decides when that step runs, collects required information, and performs its configured actions. Exact words controls the text of the selected reply.

**Why this priority**: A second consumer verifies that the feature is a shared conversational capability rather than greeting-specific settings.

**Independent Test**: Run a routine with an exact chat step and an exact terminal reply; verify the text, collected values, continuation, and completion against the configured routine.

**Acceptance Scenarios**:

1. **Given** an exact routine reply containing no slot references, **When** its step is selected, **Then** it is delivered unchanged and subsequent routine behavior remains the same as for the equivalent generated reply.
2. **Given** an exact reply containing `{{slot.orderId}}` for a collected order identifier, **When** that value is available, **Then** only the reference is substituted and the remainder of the response remains unchanged.
3. **Given** a terminal exact reply, **When** its prerequisite action succeeds and the reply is committed, **Then** the routine completes once and records the actual reply.
4. **Given** a prerequisite action that fails, **When** the routine handles that failure, **Then** it does not deliver the success step's exact reply or claim success because text was available.
5. **Given** a slot value that is unavailable at delivery, **When** an exact reply would otherwise be delivered, **Then** no partial reply or chip is emitted, the routine remains on the current step, and the unresolved-content behavior in FR-011 applies.
6. **Given** an existing routine without Exact words, **When** it runs, **Then** its current generated replies and progression remain unchanged.
7. **Given** a chat step that asks for an order identifier, **When** its exact question is delivered, **Then** the existing collection rule still captures the visitor's subsequent answer; referencing a slot in exact content does not create or move a collection step.
8. **Given** an exact terminal handoff reply, **When** that handoff is selected, **Then** the handoff state and configured wording are both preserved; wording does not turn the handoff into ordinary completion.
9. **Given** an approval step with Exact words, **When** the step is presented, **Then** the prompt text is the exact wording and the step's existing option chips and capture behavior are unchanged.
10. **Given** a tool step whose output is assigned to a slot, **When** a later exact reply references that slot, **Then** the tool result is substituted like any collected value.

---

### User Story 3 - Maintain multilingual wording (Priority: P1)

An operator supplies the agent-default-language text and optional translations at the same authoring location. The operator previews each variant and its fallback behavior before publishing.

**Why this priority**: Exact wording must work for multilingual agents without covert translation or inconsistent fallback across greetings and routines.

**Independent Test**: With agent default locale English, publish English, Estonian, and a regional language variant; exercise explicit language choice, conversation language, browser preference, and a missing translation.

**Acceptance Scenarios**:

1. **Given** an exact variant for the effective conversation language, **When** the message is resolved, **Then** that variant is used without translation.
2. **Given** a requested regional language with no exact variant but an authored base-language variant, **When** the message is resolved, **Then** the base-language variant is used; otherwise the agent default locale's variant is used.
3. **Given** fallback to the agent default locale's variant, **When** the response includes chips, **Then** text and chips come from that same variant, and the fallback does not change the conversation's language for later generated replies.
4. **Given** published wording and later draft edits to a translation, **When** a visitor receives the published revision, **Then** the visitor continues to receive the published wording.
5. **Given** an unavailable language in preview, **When** the operator selects it, **Then** preview shows the actual fallback and identifies the language being displayed.
6. **Given** two language keys that normalize to the same language tag, **When** the operator saves the content, **Then** the duplicate is rejected rather than silently overwriting a variant.
7. **Given** a change of the agent default locale to a language with no authored variant, **When** the operator attempts to publish, **Then** publication is rejected naming the consumer and the missing variant; existing variants keep their language tags.

---

### User Story 4 - Offer authored suggestion chips (Priority: P2)

An operator adds ordered starter or follow-up suggestions to an exact greeting or routine reply. Visitors can select one to send its text through the normal conversation flow.

**Why this priority**: Chips make a controlled opening useful without conflating exact wording with direct action execution.

**Independent Test**: Configure translated chip labels; select each chip and verify the message received by the agent and the resulting normal turn behavior.

**Acceptance Scenarios**:

1. **Given** an exact response with chips, **When** it is displayed, **Then** chips appear in the operator's order with the selected variant's labels.
2. **Given** a chip labelled “Compare plans”, **When** a visitor selects it, **Then** “Compare plans” becomes a user turn and existing agent rules, routing, and confirmations apply.
3. **Given** a translated chip, **When** the language changes for a later response, **Then** the chip's identity remains stable while its label uses the later response's resolved variant.
4. **Given** an exact response with no authored chips, **When** it is delivered, **Then** no generated suggestions are added to that response.
5. **Given** a partially translated chip set, **When** publication is attempted, **Then** publication is rejected with the missing label identified; runtime does not mix languages.
6. **Given** a chip click while a turn is already being submitted, **When** the visitor clicks again, **Then** existing duplicate-submission and in-progress interaction rules continue to apply.

---

### User Story 5 - Review and explain delivered wording (Priority: P2)

An operator tests exact content in an isolated candidate, publishes it through the existing workflow, and can inspect which content and language a conversation used or why a reply was blocked.

**Why this priority**: Exact wording is useful only if operators can trust what they reviewed and diagnose failures without exposing customer values in operational logs.

**Independent Test**: Test one candidate, edit the draft, publish a different candidate, and inspect conversations using each revision, including a missing-value failure and language fallback.

**Acceptance Scenarios**:

1. **Given** a pinned test candidate, **When** draft text or chips change, **Then** the existing test remains attached to its original candidate and a new test can exercise the newer candidate.
2. **Given** a successfully delivered exact response, **When** authorized history or trace inspection occurs, **Then** history contains the resolved message and chips, and trace identifies the origin, revision, requested/resolved language, and fallback outcome.
3. **Given** missing content or slot values, **When** the operator inspects the failed attempt, **Then** the reason and originating greeting or routine step are identifiable without slot values or full authored text in operational logs.
4. **Given** Ray proposing an exact-content edit, **When** the operator reviews it, **Then** it uses the same draft, validation, candidate, and publication rules as a dashboard edit.

### Edge Cases

- Leading/trailing spaces, repeated spaces, paragraphs, emoji, non-Latin scripts, and right-to-left text are preserved as authored content. Visual wrapping and existing safe rendering are not promises of byte-identical HTML or pixel-identical layout.
- A `{{…}}` sequence that does not match a known slot or context-variable reference is a validation error, not literal text; substituted values are never recursively evaluated.
- Missing, null, empty, or unauthorized values are unavailable. Numeric zero and boolean false remain valid for number and boolean slots.
- Exact selection is finalized before any answer text is exposed; a streamed generated preamble cannot precede an exact reply.
- Multiple exact candidates cannot be concatenated or blended implicitly. This delivery scope has one selected greeting or routine reply; ambiguous output selection is an explicit conflict outcome, not a best-effort message.
- A handoff or other higher-priority existing outcome retains control over whether the routine's reply is eligible. Exact wording cannot make an ineligible reply deliverable or override a failed prerequisite.
- Greeting Off suppresses the greeting and its attached exact chips. Existing empty-state wording remains a separate setting.
- Updating published exact content invalidates stale opening content for new conversations without rewriting existing conversation history or bypassing revision rules.
- A removed slot or context variable referenced by exact content is detected in candidate validation; runtime validation still covers values absent only during execution.
- Channels without chip controls receive the same text and structured suggestions through their existing contracts where supported; they do not append invented textual substitutes for chips.

## Constitution Constraints *(mandatory)*

- This specification remains Draft until explicitly approved. Planning, task generation, and implementation require approval under the project constitution.
- Preserve the project's required stack, storage, provider defaults, shared UI components, theme, and design tokens; this feature introduces no stack or provider change.
- **Authored-copy exception**: Exact words deliberately permits operator-authored conversational content as agent configuration. This supersedes the template's LLM-only-copy requirement for this explicit mode. Generated responses remain model-authored; application code must not gain hard-coded conversational responses. The delivery change must reconcile the corresponding durable project guidance explicitly.
- Backend development follows failing-test-first TDD. Frontend visible journeys use Playwright; focused unit tests cover resolution, validation, and state logic rather than CSS or markup.
- Protect customer data through existing access controls and secure transmission. No new secrets are needed; any implementation-introduced configuration or secret requirement must follow existing environment hygiene.
- Runtime LLM prompt assets, including any existing failure-generation path used by this feature, remain under `backend/prompts/`.
- Changed public contracts require code-first schema updates, regenerated OpenAPI artifacts and TypeScript SDK snapshots, contract validation, and a documented message-queue impact review.
- Update affected operator, routine, greeting, localization, API, and SDK documentation in the delivery change. Operator-facing capability ships with Ray coverage under the same authorization and draft controls.

## Architecture Constraints *(mandatory)*

- **Boundary Rule — knowledge**: Authored-content ownership covers mode, language variants, chips, and validation. It does not own conversation routing, directive matching, routine progression, slot definitions, or delivery scheduling. Conversation orchestration chooses an eligible output. Content resolution transforms only selected content and explicitly supplied values. Transport presents and persists the resolved result through existing message handling.
- **Encapsulation Rule**: Greetings retain their bootstrap lifecycle; routines retain their runner, slot model, prerequisites, and completion semantics. Neither implements a private version of exactness or locale fallback. Generic contracts and resolution do not depend on backend persistence, a specific LLM provider, or a web-chat component.
- **New Seams Required — ports**: Define one shared exact-output choice, one narrow content-resolution input/result contract, and explicit unresolved/conflict results. Consumers supply an eligible authored value, effective locale, and the authorized values already available to them; resolution returns the complete message and chips or a failure before emission. Extend existing shared ports where possible rather than duplicating structural types or adding a package per concern.
- **Dependency Direction**: Product authoring and adapters depend on the narrower shared contracts. Composition assembles concrete loaders and renderers; shared domain behavior never reaches into composition. Planning must evaluate `backend/src/app/composition/` for any replaceable runtime wiring.
- **Integration Constraints**: Exact output must retain common history, streaming completion, interruption, audit, revision selection, and chip delivery semantics. A committed reply must not be re-generated during replay. Greeting resolution is shared without forcing bootstrap through a normal customer turn.
- **Anti-Goals**: Do not enforce exactness through a prompt, parse English “say exactly” phrases out of instructions, duplicate greeting/routine logic, introduce a second interpolation syntax or a declaration/binding layer beside the existing `{{slot.<key>}}` references, add a new routine lifecycle state for failed replies, or introduce a response catalog/search service merely to deliver inline authored text.
- **Observability Review**: New exact selection, language fallback, validation failure, and blocked delivery paths need trace outcomes correlated with conversation, agent revision, and source greeting/step. Record identifiers and reason codes, never raw content or substituted values in logs, metrics, or telemetry. Keep message content in existing authorized history only. Review existing duration and failure instrumentation; add metrics only for an identified operational gap, with bounded dimensions.
- **Message-Queue Impact Review**: No new outbound delivery, document processing, or scheduled work is intended. Planning must verify whether any changed shared contract reaches existing worker or AMQP payloads, retries, or tests and record the result; an exact message does not itself enqueue an email or external action.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 — Scope**: Offer Exact words for the agent greeting, routine chat steps, routine approval-step prompts (option chips and capture behavior unchanged), and routine terminals (complete and handoff). Greeting becomes a three-way choice — Automatic, Off, Exact — replacing the current on/off toggle plus instruction; Automatic and Off keep today's behavior. Keep the default generated behavior for all existing configurations. Directive integration is follow-up scope, described below.
- **FR-002 — Local authoring**: Operators MUST author content at the consuming greeting or routine step, without first creating a named shared response. Each location owns its content and edits. Switching modes preserves inactive authored content but does not emit it.
- **FR-003 — Exact-output guarantee**: Exact words controls the complete selected assistant reply and its authored chips. Resolve and validate the entire text and chip set before emitting any part of it; once resolved, the delivered message MUST equal the chosen variant with only slot and context-variable substitutions. Do not paraphrase, translate, trim significant content, add generated preambles/closings/citations, generate additional suggestion chips, or blend, concatenate, or interleave exact content with generated prose or other exact content. A missing chip value fails the whole item. A literal exact greeting MUST require no model call and MUST NOT reserve model usage. Existing safe display behavior remains mandatory.
- **FR-004 — Explicit mode**: Exactness MUST be an explicit authoring choice enforced during delivery. Text in user messages, documents, general instructions, or substituted values cannot enable this mode or select arbitrary authored content.
- **FR-005 — Language**: The agent default locale is the single default language for exact content; every active exact item MUST carry a nonblank variant for it and MAY carry other variants keyed by normalized language tag. Resolve one effective conversation language before selecting content: an explicit visitor selection wins; otherwise routine replies use the existing resolved conversation language, and an initial greeting uses a valid request locale, then page locale, then browser locale, then the agent default locale; invalid values are ignored and no model chooses. Select the variant for the exact tag, then its base language, then the agent default locale; never a different regional sibling. Text and chips MUST resolve as one variant. Delivery uses stored variants only — no runtime translation, and translation generation/approval workflows are out of scope. Changing the agent default locale MUST NOT relabel existing variants; publication is rejected until a variant for the new locale exists. Report fallback to operators, never as extra visitor-facing text. A language switch applies to subsequent messages, not historical text.
- **FR-006 — Substitution**: Exact content reuses the routine's existing `{{slot.<key>}}` references and the existing context-variable reference form; the slot definition and context-variable definition are the declaration, and there is no separate declaration or binding layer. Only values already available to that consumer may be referenced (routine slots including tool `outputAssignments`; context variables authorized for the agent). The slot type sets the format: text, email, and date insert the stored text literally; number uses a stable non-grouped decimal; boolean uses `true` or `false`; no locale formatting or model inference occurs. Reject unknown references, non-finite numbers, and unavailable values. Substitution cannot introduce executable markup, recursively resolve references, or alter chip identity or control flow. The compiler MUST NOT treat references inside exact content as slot collection: existing instructions and slot definitions retain ownership of what a step asks for and captures, and a reference to a slot that can only be collected after the same reply is rejected at validation. An exact question may ask for a value without substituting it.
- **FR-007 — Validation**: Every variant MUST be nonblank and contain only valid references (a variant may use a reference zero or more times). Every variant MUST contain the same ordered chip identities with nonblank labels. Saving a consumer with Exact words selected requires valid complete content; incomplete edits remain in the editor with field-level diagnostics and are not silently persisted. Inactive saved exact content may be retained when Automatic/Off is selected, but must pass validation before reselecting Exact words. Publication validates every enabled consumer using Exact words.
- **FR-008 — Chips**: An exact content item MAY define zero to five ordered chips. Each chip has a stable identity and one label of 1–80 characters per variant; the label is what the visitor sees and what is submitted. Clicking submits a normal user turn through the existing `ask_followup` suggestion behavior and never directly executes a tool, skill, or routine action. Existing action-capable chips (approval options, `start_intent`) retain their behavior. This extends the public suggestion contract with a stable chip identity and adds suggestions to the bootstrap greeting response; planning records the blast radius across history, public chat, embed, SDK, and MCP surfaces.
- **FR-009 — Content limits**: A body MUST contain 1–8,000 characters after substitution and not be whitespace-only. Reject oversized content explicitly; never truncate or silently omit text or chips. Character limits count Unicode code points consistently across authoring and delivery.
- **FR-010 — Selection and precedence**: Resolve eligibility, prerequisites, and existing handoff/interruption rules before exact delivery. Once eligible, exact content takes precedence over the greeting instruction, general style instructions, and — where they reach the consumer today — matched directives' answer/suggestion wording for that reply. Such directive wording MUST NOT be appended or blended, and once/cooldown accounting MUST NOT consume it as a successful delivery; trace records the affected directives as not rendered because Exact words was selected, and Test Chat exposes them. Authoring explains this precedence. This does not bypass action permissions, confirmations, routing, or handoff outcomes; bootstrap does not gain directive matching. Conflicting structured output selections MUST produce an explicit conflict outcome. Do not infer a distinction between mandatory and stylistic prose directives with keyword rules.
- **FR-011 — Unresolved content**: A failed exact greeting returns the channel's existing unavailable/retry state without a synthetic greeting or chips. A failed exact routine reply fails that turn's delivery through the channel's existing error presentation: the routine remains on the current step, already committed action results are retained, nothing is marked delivered, and no substitute text is generated. The visitor's next message re-enters the step under the runner's existing semantics, which re-attempts resolution with the values then available; repeating already committed actions is governed by the runner's existing rules, not by this feature. No pending-reply state or explicit retry operation is introduced. Interruption or an already completed handoff keeps its existing outcome. Trace identifies the failure and its source step.
- **FR-012 — Preview**: Provide a preview for each consumer using the selected language and validated sample values for referenced slots and context variables, including chips, missing-value diagnostics, and visible fallback identification. Samples never become production defaults. Preview and delivery MUST apply identical exactness and validation rules. Previewing a chip MUST NOT execute a live action.
- **FR-013 — Publishing**: Exact mode, content, variants, and chips MUST participate in existing agent draft/candidate/publish controls and routine revision selection. Each delivery snapshots all these fields from one selected owner revision, including cached greeting content. Editing drafts never changes published behavior. New production conversations started after publication use the newly published revision; pinned tests and already active routines retain their selected revision. Any existing live-conversation revision adoption boundary must adopt a complete content item atomically and never replace the definition of an already active routine.
- **FR-014 — Compatibility**: Existing automatic greetings, Off behavior, generated routine replies, model-generated follow-up suggestions on other replies, and existing public-channel shells MUST remain unchanged unless an operator enables Exact words. Historic messages retain their originally delivered content.
- **FR-015 — Message lifecycle**: Successful exact replies MUST use existing persistence, replay, interruption, and delivery-completion semantics; a merely selected or failed reply is not reported as delivered, and replay never re-generates or duplicates a committed reply. Authoring updates MUST NOT leave fresh conversations using stale cached greetings.
- **FR-016 — Explanation and access**: Existing authorized traces MUST identify exact/generated mode, consuming greeting or routine step, agent revision, requested/resolved locale, fallback, and failure reason where applicable. Existing permissions govern authoring and history access. Audit authoring/publication through existing controls without exposing full content or customer values in operational logs.
- **FR-017 — Surface parity**: Dashboard and Ray MUST support the same authoring and validation semantics for these scoped fields, using existing proposal and publication controls. Existing programmatic authoring and chat consumers MUST be able to store or receive the scoped exact content and suggestions through their applicable contracts, with the contract changes named in FR-008 regenerated into OpenAPI and SDK artifacts. No new public proactive-send operation is part of this feature.
- **FR-018 — Documentation**: Delivery MUST document mode selection, multilingual fallback, substitution and failure behavior, chips, preview/publishing, and the boundaries of the exactness guarantee. Document the operator-authored-copy exception and programmatic contract changes with updated examples and generated SDK artifacts where applicable.

### Key Entities *(include if feature involves data)*

- **Exact content item**: Inline operator-authored content owned by a greeting or routine step; includes language variants and ordered chip identities. It inherits the owner's revision and is not an independently managed response-library entry.
- **Language variant**: One authored body and complete chip labels associated with a normalized language tag; the agent default locale's variant is mandatory.
- **Reference**: An existing `{{slot.<key>}}` or context-variable reference inside a variant; its type and availability come from the slot or context-variable definition, not from the content item.
- **Suggestion chip**: Stable identity plus one label per variant; the label is displayed and submitted. This scope introduces no direct-action chip binding.
- **Exact output choice**: The selected eligible content for one assistant reply, distinct from the decision to initiate a conversation or perform an action.
- **Resolution outcome**: Complete text and chips with provenance, or an explicit unavailable/conflict outcome before emission.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the acceptance matrix for greetings, chat steps, approval prompts, and terminal replies, 100% of successfully delivered exact messages equal the selected authored text after substitution, including whitespace, punctuation, emoji, and non-Latin text.
- **SC-002**: All tested exact-tag, base-language, and agent-default cases select the documented variant; no delivered text/chip set mixes variants or performs runtime translation.
- **SC-003**: Every tested missing value, invalid reference, oversized result, or ambiguous selection emits no partial exact message and is distinguishable from successful delivery in operator inspection.
- **SC-004**: An operator can configure, preview, and publish a literal greeting with three chips from the existing agent workflow without visiting a separate response library or editing general instructions.
- **SC-005**: All chip selections in the multilingual acceptance matrix submit the configured label through normal conversation handling, preserving confirmations and existing duplicate-submission behavior.
- **SC-006**: Tests and published conversations consistently use their selected revisions; draft changes cause zero unintended published changes, and replay scenarios produce zero duplicated committed replies.
- **SC-007**: Existing Automatic, Off, and generated-routine acceptance journeys pass unchanged. A literal exact greeting is delivered when message-generation provider access is unavailable, assuming the remaining channel dependencies are healthy.

## Assumptions

- **Delivery slices**: Slice A ships the exact greeting with variants and chips (US1, US3, US4 for greetings, US5). Slice B ships routine chat/approval/terminal exact replies with slot substitution (US2, US3/US4 for routines). Each slice is independently shippable and each exercises the shared exact-output contract; preview with sample values (FR-012) may land with Slice B. Directive integration is a separately specified follow-up. Scope remains subject to product review; Draft status does not record approval.
- **Common capability**: The shared exact-output contract must admit future consumers without copying language or rendering rules. Ordinary replies still use existing generation unless a scoped consumer selects Exact words; no new global response-matching behavior is introduced.
- **Directive follow-up**: A later directive integration should attach a structured exact-output choice to an otherwise normally matched directive. Its spec must define precedence between simultaneous exact directives and active routines, replacement versus mandatory additional content, once/cooldown accounting on actual delivery, and failure/handoff behavior. Those unresolved policy choices are intentionally outside this delivery and must be decided before directive authoring is exposed.
- **Reuse**: No named response library, cross-agent sharing, semantic template retrieval, independently versioned catalog, or migration into such a catalog is required. Existing agent and routine revisions supply content versioning.
- **Proactive communication**: Agent-initiated turns, `utter`, first emails, outbound adapters, scheduling, and delivery queues are separate work. Exact words may supply their future message content but does not authorize or initiate a send.
- **Composition**: Locked fragments mixed with generated prose, model-filled variables, template expressions/loops, per-channel email subjects, generated translation assistance, separate chip labels versus submitted text, and authored direct-action chips are outside this delivery.
- **Planning verifications**: Before tasks are cut, planning must confirm against current code (a) whether matched directive answer wording reaches routine-step replies at all — if not, the directive clauses of FR-010 reduce to trace notes; (b) which context variables are available at bootstrap, since the greeting has no user turn — if none, greeting substitution is empty in Slice A; (c) that the exact greeting path skips the bootstrap usage reservation; (d) how the current greeting toggle plus instruction migrates to the three-way mode without changing published behavior; (e) that the routine runner's existing re-entry of a step after a failed turn satisfies FR-011 without new state.
- **Dependencies**: Reuse current greeting locale selection, agent candidate/publication controls, routine slot and context-variable access, the public suggestion contract, and safe presentation.
- **Relevant documentation**: Delivery should update `docs/authoring-routines.md`, `docs/settings-docs/general/greeting-instruction.md`, `docs/settings-docs/general/assistant-default-locale.md`, `docs/settings-docs/general/proactive-greeting-enabled.md`, and the applicable public-chat/SDK guidance. Explain in suggested-question settings that generated suggestions on other replies are separate from authored exact chips.
- **Product defaults**: The five-chip, 8,000-character body, and 80-character label limits are proposed defaults chosen to keep validation and responsive presentation bounded; approval of this spec approves those limits.
