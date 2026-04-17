# Feature Specification: Website Embed Widget

**Feature Branch**: `040-website-embed-widget`  
**Created**: 2026-04-15  
**Status**: Draft  
**Input**: User description: "Explore an embeddable website widget for Radioso using a hosted public chat surface, thin loader script, iframe shell, domain allowlists, and short-lived embed session tokens rather than connector plugins or a separate repo." Updated 2026-04-16 to add script-defined locale overrides, default open/collapsed state, and custom collapsed-avatar support.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install The Assistant On A Website (Priority: P1)

A workspace operator enables website embed in settings, copies a one-line install snippet, adds it to their website, and sees a Radioso launcher appear in the configured corner without building their own chat UI.

**Why this priority**: This is the activation moment. Without a simple installation flow, the feature does not become a real distribution channel.

**Independent Test**: Can be fully tested by enabling website embed for one workspace, copying the generated snippet into a test site header, loading the page on an approved domain, and confirming the launcher renders with the saved configuration.

**Acceptance Scenarios**:

1. **Given** website embed is disabled for a workspace, **When** the operator enables it in settings, **Then** the system shows a copyable install snippet and the approved domain configuration for that workspace.
2. **Given** website embed is enabled and the current page origin is approved, **When** a website includes the Radioso install snippet, **Then** a launcher appears in the configured position without requiring the host site to bundle Radioso UI code.
3. **Given** a workspace operator changes the launcher label, icon choice, or position, **When** the embedded launcher loads on the website, **Then** the launcher reflects the saved settings for that workspace.

---

### User Story 2 - Visitor Chats Inside The Embedded Assistant (Priority: P1)

A website visitor clicks the launcher, sees a Radioso-hosted chat window open inside the page, and chats with the workspace assistant using the same knowledge base, greeting rules, and response behavior as the public chat surface.

**Why this priority**: This is the user-facing value. The install flow matters only because it leads to a usable embedded assistant experience.

**Independent Test**: Can be fully tested by opening an approved site containing the snippet, clicking the launcher, sending a first message, receiving a response, refreshing the page, and confirming the same embedded session continues safely in that browser.

**Acceptance Scenarios**:

1. **Given** the launcher is visible on an approved domain, **When** the visitor clicks it, **Then** an embedded chat window opens inside the page and loads the workspace assistant experience.
2. **Given** an embedded chat starts a brand-new conversation, **When** assistant bootstrap is configured for the workspace, **Then** the embedded conversation uses the same workspace identity and request-scoped locale rules as the public chat surface.
3. **Given** the visitor sends a message through the embedded assistant, **When** the assistant responds, **Then** the response uses the same public-chat retrieval and answer pipeline as other unauthenticated chat entry points for that workspace.
4. **Given** the visitor reloads the same website in the same browser, **When** the embedded assistant opens again, **Then** the visitor can continue the same embedded conversation history unless the session has expired or been cleared.

---

### User Story 3 - Reject Unapproved Or Unsafe Embeds (Priority: P1)

A workspace operator can restrict which websites may host the embedded assistant, and the system refuses to load or chat when the widget is installed on an unapproved origin or when embed access has been disabled.

**Why this priority**: The feature creates a public distribution surface. Secure-by-default hosting controls are part of the MVP, not a follow-up.

**Independent Test**: Can be fully tested by enabling website embed for one approved domain, loading the snippet on both the approved and an unapproved domain, and verifying the approved site works while the unapproved site fails safely without exposing privileged tokens.

**Acceptance Scenarios**:

1. **Given** website embed is enabled with an approved-domain list, **When** the snippet loads on an approved origin, **Then** the embedded assistant may request a session and operate normally.
2. **Given** the same snippet is copied to an unapproved origin, **When** the launcher attempts to initialize, **Then** the embedded assistant fails safely and does not issue a usable session for that page.
3. **Given** website embed is later disabled for the workspace, **When** a previously approved website loads the snippet, **Then** new embedded sessions are blocked and the launcher shows an unavailable state instead of a broken or blank experience.

---

### User Story 4 - Monitor And Operate The Embedded Channel (Priority: P2)

A workspace operator can understand whether website embed is enabled, where it is allowed to run, how to install it, and whether embedded traffic is being accepted or rejected for security reasons.

**Why this priority**: Operators need confidence and debuggability before they will deploy a public-facing assistant on their own domain.

**Independent Test**: Can be fully tested by enabling website embed, reviewing the settings page and audit trail, then attempting both valid and rejected launches and confirming the operator can distinguish allowed traffic from blocked traffic.

**Acceptance Scenarios**:

1. **Given** website embed is enabled, **When** the operator views settings, **Then** they can see the install snippet, approved domains, and current launcher configuration in one place.
2. **Given** an embed launch is rejected because the origin is unapproved or the feature is disabled, **When** the rejection occurs, **Then** the system records enough operator-visible diagnostics or audit information to explain the rejection without exposing visitor secrets.

---

### User Story 5 - Tune Widget Launch Behavior In The Install Snippet (Priority: P2)

A website operator can adjust the embed snippet itself so the launcher opens in the preferred initial state, uses a custom avatar image or GIF when collapsed, and renders common widget text in the desired locale without changing workspace-wide settings.

**Why this priority**: These controls improve installation quality on multilingual or highly branded websites, but they matter only after the core embed path works.

**Independent Test**: Can be fully tested by installing the widget with custom script attributes, loading the page, and confirming the launcher starts in the requested state, renders the requested collapsed avatar, and shows the supported widget copy in the requested locale while assistant bootstrap uses the same locale hint for a new conversation.

**Acceptance Scenarios**:

1. **Given** a website includes the embed snippet with a supported locale override, **When** the launcher and hosted embed surface load, **Then** the common widget copy uses that locale instead of the browser default.
2. **Given** a website includes the embed snippet with an initial-state override, **When** the page loads, **Then** the launcher starts open or collapsed exactly as requested without requiring a click to reach the chosen default state.
3. **Given** a website includes the embed snippet with a custom avatar image or GIF URL, **When** the launcher is collapsed, **Then** the launcher displays that asset in place of the default icon while preserving an accessible control label.
4. **Given** the snippet omits these optional attributes or provides unusable values, **When** the widget loads, **Then** the widget falls back safely to the current default locale, collapsed state, and built-in icon behavior.
5. **Given** a visitor wants to discard the current thread, **When** they choose the new-chat action from the widget, anonymous chat page, or authenticated chat view, **Then** the current conversation is cleared and a fresh conversation starts without leaving the active surface.

### Edge Cases

- What happens when a website includes the snippet before the workspace has approved that domain? The launcher must fail safely and avoid issuing a usable embedded session.
- What happens when the host page blocks third-party framing or scripts through its own browser policies? The operator should receive a clear failure mode instead of a silent partial render.
- What happens when assistant bootstrap is empty or proactive greeting is disabled? The embedded chat should start silently, matching other public chat surfaces.
- What happens when a visitor opens multiple tabs of the same approved site? Each tab must preserve safe session isolation rules without leaking conversation state across workspaces.
- What happens when an embed session token expires while the chat is open? The system must fail predictably, allowing a safe refresh or re-establishment flow instead of exposing privileged credentials.
- What happens when a workspace removes a domain from the allowlist while visitors are active? New embedded sessions must be blocked immediately; in-flight behavior must degrade predictably without cross-origin leakage.
- What happens when the snippet specifies a locale that the widget does not recognize? The widget should ignore the unsupported value and fall back to the existing browser-driven or workspace-default behavior.
- What happens when the snippet specifies an avatar asset that fails to load? The launcher should fall back to the built-in icon without breaking the control or leaving an empty surface.
- What happens when the snippet requests the widget to start open on a very small viewport? The widget should still respect layout bounds and remain dismissible without trapping the page.
- What happens when a user starts a new chat while a response is still streaming? The UI should prevent overlapping resets and only allow a fresh start from a stable state.

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
- Backend HTTP contract changes MUST update the code-first OpenAPI registry and regenerate checked-in OpenAPI outputs.
- Operator-facing settings, public contract changes, and installation workflow changes MUST update the relevant documentation in the same feature.
- The feature SHOULD introduce the minimum number of new seams, modules, and cross-module imports needed to preserve security boundaries and maintainability.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Settings routes own embed configuration transport only; embed-specific access checks and short-lived session issuance should extend the smallest existing public-chat-compatible orchestration surface that can safely own them; public chat or embed transport routes own request validation and response transport only; existing chat orchestration remains the single answer-generation path; repositories own persistence and audit storage.
- **Encapsulation Rule**: Existing connector modules and plugin infrastructure must remain external-channel-only and must not absorb website embed behavior. `chatRoutes.ts` and public-chat routes must remain transport-only and must not grow launcher rendering or browser-origin policy logic. Settings UI components may collect embed configuration but must not own runtime allowlist enforcement or token rules. New imports into existing core modules should be minimized, and any new shared logic must justify why it cannot live beside the existing public-chat path.
- **New Seams Required**: Only the seams that are strictly necessary to preserve the browser trust boundary should be introduced: website-embed settings persistence, approved-origin plus short-lived session issuance for embed access, a hosted embed surface entry point optimized for iframe rendering, and a thin installer-script seam that handles launcher rendering plus iframe lifecycle without privileged API access.
- **Anti-Goals**: Do not create a separate repository for v1. Do not model website embed as a connector plugin. Do not expose workspace tokens, admin tokens, or long-lived privileged credentials in the browser snippet. Do not require host websites to bundle Radioso React components directly into their own apps. Do not fork the embedded chat UI into a second independently maintained chat surface.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST let a workspace operator enable or disable website embed independently of other chat channels.
- **FR-002**: When website embed is enabled, the system MUST generate and display a copyable install snippet for that workspace.
- **FR-003**: The system MUST let the operator define at least one approved website origin where the embed may run.
- **FR-004**: The system MUST refuse to establish a usable embedded session when the launcher is loaded from an origin that is not approved for that workspace.
- **FR-005**: The install snippet MUST load a Radioso-owned launcher and hosted chat surface without requiring the host website to compile or bundle Radioso application code.
- **FR-006**: The embedded chat surface MUST open within the host page as a bounded chat window rather than redirecting the visitor away from the website.
- **FR-007**: Embedded conversations MUST use the same workspace knowledge base, assistant identity, and public-chat answer path as the hosted public chat experience.
- **FR-008**: Embedded brand-new conversations MUST support the same request-scoped locale behavior used for public chat startup.
- **FR-009**: The system MUST issue short-lived, audience-scoped embed session credentials for browser sessions instead of exposing long-lived privileged workspace credentials in the install snippet.
- **FR-010**: The system MUST persist or restore embedded visitor conversation continuity using a browser-safe session mechanism that does not reveal admin or workspace secrets to the host page.
- **FR-011**: The system MUST let operators configure basic launcher presentation controls for the embedded surface, including position and visible launcher labeling.
- **FR-012**: When website embed is disabled, misconfigured, or blocked by domain policy, the launcher or embed surface MUST fail with a user-friendly unavailable state rather than a blank or broken widget.
- **FR-013**: The system MUST apply abuse controls and rate-limiting rules to embedded chat sessions at least as strict as other public unauthenticated chat surfaces.
- **FR-014**: The system MUST record audit or operator-visible diagnostics for website-embed enablement changes and rejected embed session attempts.
- **FR-015**: Operators MUST be able to review the current website-embed configuration, including enabled state, approved origins, and install snippet, from settings.
- **FR-016**: The system MUST allow future extension of the website embed channel without requiring a separate repository or a rewrite of the public-chat foundation.
- **FR-017**: The implementation MUST prefer extending existing public-chat and settings flows over introducing new shared abstractions, imports, or modules unless those additions are necessary for security boundaries, operator clarity, or long-term maintainability.
- **FR-018**: The install snippet MUST support an optional locale override that controls common launcher and embedded-surface copy and supplies the same locale hint to assistant bootstrap for brand-new conversations.
- **FR-019**: The install snippet MUST support an optional initial-state override so the widget can start open or collapsed on first render.
- **FR-020**: The install snippet MUST support an optional image or GIF URL for the collapsed launcher avatar while preserving an accessible text label and a safe built-in icon fallback.
- **FR-021**: Unsupported or malformed script-level overrides for locale, initial state, or avatar asset MUST fail safely without blocking the widget from loading.
- **FR-022**: The authenticated chat view, anonymous public chat view, and embedded widget MUST expose a user-triggered new-chat action that clears the active conversation state and starts a fresh thread without requiring navigation away from the current surface.

### UI Tasks

- Add a website-embed section to General Settings with an enable/disable control and clear plain-language explanation of how embed works.
- Show a copyable install snippet for enabled workspaces.
- Provide an approved-domain management UI that makes it clear which origins are allowed to host the assistant.
- Provide compact launcher controls for position, visible label, and basic visual choice without turning the settings screen into a full theme builder.
- Show clear unavailable and misconfiguration states for operators previewing the embedded experience.
- Keep the embedded chat window visually aligned with existing chat components rather than inventing a disconnected UI language.
- Document the optional script attributes for locale override, initial state, and custom collapsed avatar directly where operators copy the embed snippet.
- Keep the new-chat affordance visually consistent across authenticated, anonymous, and embedded chat surfaces.

### Key Entities *(include if feature involves data)*

- **Website Embed Settings**: Workspace-scoped operator configuration describing whether embed is enabled, which origins are allowed, how the launcher should appear, and how the install snippet is generated.
- **Embed Session Grant**: A short-lived browser-scoped grant used by the hosted embed surface to start or continue a visitor session without exposing privileged workspace credentials.
- **Embedded Visitor Session**: A public chat session associated with a browser context launched from an approved website origin and linked to one workspace's embedded assistant experience.
- **Embed Launch Audit Event**: A recorded operator-visible event describing allow/deny decisions and configuration changes relevant to website embed security or availability.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In validation, an operator can enable website embed, configure at least one approved origin, and copy the install snippet in under 2 minutes.
- **SC-002**: In validation, a visitor on an approved website can open the embedded assistant and send a first message in under 10 seconds from page load.
- **SC-003**: In validation, 100% of covered embed launches from unapproved origins are rejected without exposing a reusable privileged credential to the browser snippet.
- **SC-004**: In validation, embedded conversations use the same covered public-chat answer path and assistant bootstrap behavior as the hosted public chat surface.
- **SC-005**: In validation, disabling website embed immediately blocks new embedded sessions for that workspace while failing with a user-friendly unavailable state.
- **SC-006**: In validation, operators can distinguish successful versus rejected embed launches through settings-visible diagnostics, audit history, or equivalent operator tooling.

## Assumptions

- Website embed will build on the same public-chat foundation already planned for unauthenticated access rather than introducing a separate answer-generation pipeline.
- A hosted iframe surface is the preferred v1 trust boundary because it keeps Radioso in control of UX, rollout, and browser security posture.
- Basic launcher customization is sufficient for the first release; deep theme APIs and custom host-page component embedding are deferred.
- Script-level installation overrides are appropriate for per-site presentation and locale concerns that should not mutate shared workspace settings.
- Operators are responsible for adding the install snippet to websites they control and for maintaining any host-page browser policy changes needed to allow the embed.
- The planning and implementation phases should default to the smallest safe change set, adding new seams only when an existing path cannot absorb the feature without violating transport, orchestration, or security boundaries.
