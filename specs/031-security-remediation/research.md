# Research: Security Remediation

## Decision 1: Use the existing account session cookie as the only browser-held admin credential

- **Decision**: Replace browser-persisted workspace bearer token usage with session-authenticated workspace context. The browser may keep only non-sensitive workspace selection state, while backend admin routes resolve the active workspace from the authenticated account session plus explicit workspace selection data.
- **Rationale**: This removes the highest-value theft target from persistent browser storage while preserving the current signed-in UX. It also simplifies the trust model by making the existing HTTP-only account session the only browser credential that grants admin access.
- **Alternatives considered**:
  - Keep bearer tokens in `localStorage` and add client-side obfuscation. Rejected because obfuscation does not meaningfully reduce XSS or extension theft risk.
  - Rotate short-lived bearer tokens in browser storage. Rejected because the browser would still hold reusable bearer credentials and the admin trust model would remain split.
  - Keep bearer-token auth for admin APIs and move tokens to session storage only. Rejected because it reduces persistence but does not remove the fundamental browser exfiltration risk.

## Decision 2: Make connector secret encryption fail closed and treat legacy plaintext rows as explicit remediation state

- **Decision**: Reject new secret writes whenever connector encryption configuration is missing or invalid, and treat legacy unencrypted secret values as records that must be re-entered or rotated by an operator before they can be trusted.
- **Rationale**: Silent plaintext fallback is worse than temporary operational friction. Legacy rows cannot be safely auto-upgraded because plaintext-at-rest history cannot be reversed into trustworthy ciphertext without operator intent.
- **Alternatives considered**:
  - Continue plaintext fallback and log a warning. Rejected because it preserves the original vulnerability.
  - Auto-encrypt any value that fails decryption on read. Rejected because it conflates plaintext legacy rows with malformed ciphertext and hides provenance.
  - Block application startup whenever any legacy row exists. Rejected because it creates unnecessary outage risk when only connector configuration is affected.

## Decision 3: Use PostgreSQL-backed abuse-control state rather than process-local memory

- **Decision**: Implement a shared abuse-control service backed by PostgreSQL for login, registration, token/session-sensitive endpoints, uploads, and anonymous chat.
- **Rationale**: The repo already depends on PostgreSQL, and the problem being solved is consistency across restarts and multi-instance deployment. PostgreSQL provides a durable shared coordination point without introducing new infrastructure.
- **Alternatives considered**:
  - Keep the current in-memory limiter and tighten thresholds. Rejected because it still resets per process and does not work across multiple instances.
  - Introduce Redis or a third-party rate-limit service. Rejected for this feature because it adds new infrastructure and operational scope beyond the current remediation need.
  - Log abuse signals only and rely on external edge controls. Rejected because the application still needs an internal enforcement guarantee for customer-data protection.

## Decision 4: Replace the vulnerable spreadsheet parsing path instead of carrying it as accepted risk

- **Decision**: Remove the current vulnerable spreadsheet parsing dependency from the production import path and replace it with a maintained alternative limited to the read-only extraction behavior the product actually uses.
- **Rationale**: The current advisory set on the spreadsheet parser has no clean in-place patch path. The product requirement is content extraction, not full workbook manipulation, so a narrower parser choice reduces attack surface.
- **Alternatives considered**:
  - Accept the vulnerable package and document compensating controls. Rejected because the import path is reachable and the package carries unresolved high-severity issues.
  - Disable spreadsheet import entirely. Rejected as the fallback option only if replacement proves unsafe during implementation; keeping supported imports is preferred.
  - Leave the current parser in place and wrap it with more validation. Rejected because input validation does not remove parser-level prototype-pollution or ReDoS risk.

## Decision 5: Treat lockfile refresh and supported-release upgrades as the primary remedy for the remaining dependency advisories

- **Decision**: Resolve the remaining backend/frontend advisories by upgrading to supported patched dependency lines and regenerating lockfiles, then verify against the actual production dependency graph.
- **Rationale**: The audit findings are on standard framework and transitive package paths. The lowest-risk remediation is to move onto patched supported releases and re-verify behavior.
- **Alternatives considered**:
  - Patch transitive dependencies ad hoc while pinning old framework versions. Rejected because it raises maintenance burden and weakens future upgrade posture.
  - Ignore moderate framework advisories because they are not immediately exploitable in every deployment. Rejected because this feature is specifically for security remediation and the supported fix path exists.
