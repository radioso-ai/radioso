# Specification Quality Checklist: Personal API Tokens and Workspace Service Accounts

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-31
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details beyond mandatory architecture and security-boundary constraints
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders where possible
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No `[NEEDS CLARIFICATION]` markers remain
- [x] Requirements are testable and unambiguous
- [x] UI tasks are captured for user-facing behavior
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic where possible
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope and non-goals are clearly bounded
- [x] Dependencies and assumptions are identified
- [x] Security migration behavior is explicit
- [x] Legacy secret ciphertext and verifiers are irreversibly disposed rather than retained behind a revoked flag
- [x] Role ordering, selectable ceilings, effective-role results, and session lifecycle permissions have settled matrices
- [x] Concurrent rotation and lost one-time response behavior are explicit
- [x] Mixed session-plus-bearer precedence and the absence of bearer fallback for lifecycle routes are explicit
- [x] REST, SDK, UI, documentation, audit, observability, and test impacts are included
- [x] Message-queue impact is reviewed and explicitly expected to be unaffected

## Security and Authorization

- [x] Personal credentials remain bound to users while service accounts are first-class stable principals with multiple credentials
- [x] Service-account enabled, disabled, and archived states have distinct credential effects
- [x] Personal ceilings and service-account authority are bounded by centralized workspace roles
- [x] Owner authority and sensitive session-only operations are excluded
- [x] One-time secret display and non-recoverable storage are required
- [x] Revocation, expiry, rotation, and live access-change behavior are defined
- [x] Personal-token non-revival is bound to a durable continuous-access tenure
- [x] Public launch, agent-converse, OAuth, Ray, and skill-catalogue boundaries are explicit
- [x] Legacy backend verifiers immediately invalidate API-token-backed MCP sessions, and controlled MCP stores purge recoverable copies before readiness
- [x] New API credentials are explicitly rejected by MCP pending the subsequent MCP authorization specification

## Architecture Readiness

- [x] Transport, orchestration, domain, persistence, and composition responsibilities are separated
- [x] `AccountAccessService`, `AuthService`, persistence adapters, frontend clients, and MCP mounts have explicit limits
- [x] New focused lifecycle, persistence, principal, and migration seams are required
- [x] Dependency direction is explicit
- [x] Per-token custom scopes and reuse of agent access grants are rejected as architecture anti-goals

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary and recovery flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No avoidable implementation details leak into the specification
- [x] The specification is ready for stakeholder approval before `/speckit.plan`

## Notes

- Stakeholder approval was recorded on 2026-08-31. The specification gate is closed; later scope changes require renewed approval before implementation.
- The repository's branch-creation helper was intentionally not run because it would rename the current Conductor branch, which is prohibited without explicit user direction. The globally next available feature ID, `1117`, is used for the specification directory while the current branch name is preserved.
- The specification deliberately uses a personal member/admin ceiling and a live service-account member/admin role instead of custom `scopes[]`, consistent with the centralized role-to-permission model and the Phase 2 boundary discussed in issue #352.
- A first-class service account is the stable non-human principal; replaceable credentials carry no independent role and preserve audit identity across deployment and rotation.
- Legacy shared tokens are intentionally destroyed at upgrade because their recoverable administrator secret may already have been copied by a member. No backward-compatibility window is required, and legacy API-token-backed MCP sessions are purged.
- Personal and service-account credentials are rejected by MCP in this feature. Existing agent-converse credentials remain unchanged; OAuth, MCP credential exchange, Ray/Operator MCP, external skill-catalogue access, and new MCP policy remain deferred.
- The published TypeScript SDK remains a bearer-token consumer. Token minting and lifecycle management are session-authenticated REST/dashboard operations until session-capable SDK support receives a separate design.
- An initial adversarial review resolved access-tenure, role-matrix, rotation-race, mixed-auth, legacy-ciphertext, and SDK-authentication ambiguities. A separate Codex Sol review then drove the first-class service-account model, credential/principal separation, bounded inventory, expiry warnings, broader audit attribution, and the explicit MCP deferral.
