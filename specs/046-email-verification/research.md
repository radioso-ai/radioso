# Research: Email Verification Gate

## Decision: verification state lives on `users`

Rationale: the spec explicitly requires a shared identity seam that future Google/GitHub auth can reason about. `users` already represents the login identity; account membership is layered on top.

Alternatives considered:
- `accounts`: wrong boundary because a user can belong to multiple accounts.
- session-only state: cannot support future auth methods or durable sign-in gating.

## Decision: dedicated verification tokens, not password-reset reuse

Rationale: reset and verification have different lifecycle semantics and audit meanings. Separate persistence avoids accidental cross-flow acceptance and preserves clear module ownership.

Alternatives considered:
- reusing `password_reset_tokens`: rejected for security and clarity.
- stateless signed tokens only: rejected because one-time use and resend invalidation need durable server-side control.

## Decision: registration provisions the identity and account but does not create a session

Rationale: the product wants unverified users unable to sign in. Creating the user/account on registration still keeps onboarding simple and preserves the existing account bootstrap path after verification.

Alternatives considered:
- defer user creation until verification: adds complexity around invitations/workspaces and breaks current bootstrap assumptions.
- create a session before verification: violates the approved spec.

## Decision: resend is explicit and safe for unverified users only

Rationale: matches the approved brief and limits abuse. The service should accept idempotently for already verified users without reopening verification.

Alternatives considered:
- auto resend on login: out of scope and noisy.
- fail hard for verified users: unnecessary branch-specific complexity in UI.
