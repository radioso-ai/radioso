# Research: Website Embed Widget

## Decision 1: Reuse the existing public-chat answer path and anonymous session model

**Decision**: Build website embed on top of the current public-chat transport and anonymous-session continuity model rather than introducing a second answer-generation path.

**Rationale**: The backend already has a stable public chat route, anonymous session resolution, rate limiting, assistant bootstrap support, and conversation history continuity. Reusing those behaviors keeps imports and seams low while preserving the hosted-iframe trust boundary required by the spec.

**Alternatives considered**:
- Create a connector-style runtime module for website embed. Rejected because connectors are designed for external webhook channels, not first-party browser surfaces.
- Create a separate embed-specific chat orchestration service. Rejected because it would fork answer-generation behavior and create long-term drift.

## Decision 2: Additive workspace-scoped embed settings, not a new settings subsystem

**Decision**: Store website-embed configuration as additive workspace-level settings and extend the existing General Settings route/response rather than creating a new settings domain or service layer for v1.

**Rationale**: General Settings already owns anonymous chat and assistant bootstrap, which are the closest existing operator surfaces. Adding embed fields to the same route minimizes new imports and avoids a new end-to-end settings stack for one adjacent feature.

**Alternatives considered**:
- Introduce a dedicated website-embed settings service and route namespace. Rejected as unnecessary indirection for v1.
- Store embed settings in a new table. Rejected because the expected configuration is small, workspace-scoped, and can be modeled as additive columns without cross-workspace joins.

## Decision 3: Use a dedicated website-embed token, not the anonymous public-link token

**Decision**: Issue and persist a dedicated workspace-scoped embed token for the installer snippet and embed session bootstrap flow.

**Rationale**: The spec requires website embed to be independently controllable from anonymous public-link access. A dedicated token preserves that independence and keeps toggle semantics clear, while still following the existing pattern of non-guessable workspace-scoped public tokens.

**Alternatives considered**:
- Reuse `anonymousChatToken` for both public links and embed. Rejected because it couples channel enablement and makes future channel-specific auditing and revocation harder.
- Embed by workspace id only. Rejected because ids are not channel secrets and would unnecessarily widen enumeration risk.

## Decision 4: Prefer sibling embed-specific files over a generalized public-access abstraction

**Decision**: Add focused embed-specific middleware/routes/components beside the existing anonymous chat files instead of first extracting a generalized “public access” abstraction.

**Rationale**: The repo already has a clear anonymous-chat path. A sibling embed path introduces fewer new cross-module imports than a broad generalization and respects the user’s preference to add as few seams as possible. Small, localized duplication is acceptable when it avoids speculative shared abstractions.

**Alternatives considered**:
- Refactor anonymous and embed flows immediately into a generic public-visitor framework. Rejected because the additional seam count is not justified yet.
- Inline all embed checks into existing public-chat files. Rejected because it would blur transport and policy responsibilities inside already-important entry points.

## Decision 5: Keep the hosted iframe as the primary trust boundary

**Decision**: The installer script should render a launcher and open a Radioso-hosted iframe, with all actual chat UI and public-chat requests running inside that iframe.

**Rationale**: This keeps privileged behavior on Radioso-controlled origins, reduces CSP and styling drift in customer sites, and prevents the host page from directly owning the assistant runtime. It also fits the existing public chat page model, making reuse straightforward.

**Alternatives considered**:
- Ship a fully in-page JavaScript widget that directly renders chat UI into the host DOM. Rejected because it increases browser trust, styling, and support complexity.
- Redirect users to the hosted public chat page. Rejected because the product goal is an embedded assistant that stays on the customer’s site.

## Decision 6: Use short-lived embed grants for approved origins

**Decision**: Add a lightweight embed-session bootstrap endpoint that validates the requesting origin against the workspace allowlist and returns a short-lived, audience-scoped grant for the hosted iframe.

**Rationale**: The installer snippet must not carry long-lived privileged credentials. A short-lived grant enforces origin checks at launch time and allows iframe startup without turning the snippet into a secret transport.

**Alternatives considered**:
- Let the iframe use only the long-lived workspace embed token. Rejected because it weakens the origin boundary and complicates revocation semantics.
- Require the host page to proxy Radioso requests. Rejected because it increases operator complexity and defeats the one-line install goal.

## Decision 7: Prefer additive workspace fields before new tables

**Decision**: Represent website-embed enablement, token, approved origins, and basic launcher configuration as additive fields on `workspaces` before considering new tables.

**Rationale**: The data is naturally workspace-scoped, small in volume, and fetched alongside other general settings. Keeping it on `workspaces` reduces joins, repository proliferation, and write orchestration.

**Alternatives considered**:
- New `website_embed_settings` table. Rejected because it adds persistence seams with little v1 value.
- Persist launcher config only in frontend state. Rejected because operators expect durable settings and install reproducibility.

## Decision 8: Extend existing documentation surfaces

**Decision**: Update `readme.md` and General Settings docs in the same feature, keeping website embed documented beside anonymous chat and assistant bootstrap.

**Rationale**: Embed changes operator workflow, settings, and public contract behavior. Existing docs already reference popup/embed-oriented locale behavior, so they are the right place to extend.

**Alternatives considered**:
- Create standalone docs only under a new embed folder. Rejected because it would scatter operator guidance across too many surfaces for a first release.
