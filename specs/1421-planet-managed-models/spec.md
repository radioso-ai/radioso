# Feature Specification: Planet Managed Models

**Feature Branch**: `feat/planet-managed-models-1421`

**Created**: 2026-10-13

**Status**: Approved

**Input**: GitHub issue #1421 and the delivery instructions for the BYOK credential audit and Planet managed-model plan variant.

## User Scenarios & Testing

### User Story 1 - Keep BYOK Credentials Tenant-Owned (Priority: P1)

As a Planet customer on the bring-your-own-key plan, I need every model and embedding operation to use only provider credentials configured for my workspace so the platform never silently subsidizes usage with its own credentials.

**Why this priority**: A platform-credential fallback would be a billing and tenant-policy leak.

**Independent Test**: Resolve model and embedding capabilities for a BYOK Planet workspace with no provider credentials while platform environment credentials are configured, then verify that every chat, Ray, ingestion, suggestions, and summary path reports the existing connect-provider state instead of receiving a platform credential.

**Acceptance Scenarios**:

1. **Given** a workspace assigned to a plan whose catalog model mode is `byok` and no workspace provider credential exists, **when** any model or embedding capability is resolved, **then** no platform environment credential is returned.
2. **Given** the same workspace and platform provider credentials, **when** chat, Ray, document embedding, suggested-question, or summary work starts, **then** the operation follows the existing unavailable-provider/connect-provider behavior.
3. **Given** a workspace assigned to a managed-model plan, **when** a supported capability is resolved, **then** the platform-managed credential remains available through the existing policy boundary.

---

### User Story 2 - Choose Managed Models On Planet (Priority: P1)

As a Planet buyer, I need to choose either my own provider keys or Radioso-managed models so I can trade provider administration for a clear monthly premium.

**Why this priority**: The approved €749/month option cannot be purchased or represented until it is a first-class catalog plan.

**Independent Test**: Fetch catalog plans and exercise billing UI selection, checkout mapping, webhook assignment, and upgrade helpers for `planet_managed`, verifying Planet quota parity and the approved managed-model price and usage rate.

**Acceptance Scenarios**:

1. **Given** the plan catalog, **when** `planet_managed` is read, **then** it costs €749 monthly or €7,490 yearly, uses managed models, charges €0.05 per conversation, and otherwise matches Planet allowances.
2. **Given** a buyer viewing Planet, **when** they select Radioso's models, **then** the UI clearly identifies the €250/month premium and checks out the managed variant.
3. **Given** Stripe test prices synchronized from the catalog, **when** checkout or a webhook resolves the new lookup keys, **then** the existing catalog-native billing path assigns `planet_managed` without a new billing code path.
4. **Given** plan ordering, upgrade, downgrade, analytics, or operator-console logic, **when** it receives `planet_managed`, **then** it treats the variant intentionally rather than as an unknown plan.

### Edge Cases

- A BYOK workspace has a provider row with no usable credential or an unsupported provider configuration.
- Platform environment credentials exist while the assigned plan is BYOK.
- A managed Planet workspace changes to Planet BYOK or to a lower managed plan.
- The new Stripe price lookup keys do not yet exist in live mode; test sync may run locally, but live sync remains an owner-run deployment step.
- Existing Planet assignments and price lookup keys remain stable.

## Requirements

### Functional Requirements

- **FR-001**: BYOK plans MUST never resolve platform-managed provider credentials for language-model or embedding capabilities.
- **FR-002**: The credential boundary MUST cover chat turns, Ray/copilot, document-worker embeddings, suggested questions, conversation summaries and titles, and every other model or embedding call site discovered during implementation.
- **FR-003**: Missing BYOK credentials MUST preserve the existing operator-facing connect-an-AI-provider state.
- **FR-004**: Automated tests MUST pin the BYOK-without-keys behavior even if the audit finds no current leak.
- **FR-005**: The plan catalog MUST define `planet_managed` as a managed-model variant priced at 74,900 monthly units and 749,000 yearly units after verifying catalog units.
- **FR-006**: `planet_managed` MUST charge the same managed-model per-conversation rate as Satellite and otherwise have quota and allowance parity with Planet.
- **FR-007**: Existing catalog-derived managed-model policy, Stripe lookup-key mapping, checkout, and webhook assignment MUST support the new plan without a plan-specific runtime path.
- **FR-008**: The billing UI MUST offer an explicit Planet choice to use Radioso's models for an additional €250/month.
- **FR-009**: Upgrade, downgrade, display ordering, analytics, and Enterprise operator-console plan enumerations MUST handle `planet_managed` intentionally.
- **FR-010**: Stripe catalog sync definitions MUST include the new monthly and yearly prices. Only test-mode sync MAY run during implementation; live sync MUST be documented as an owner-run step with the exact command.
- **FR-011**: Pricing and billing documentation in `docs-portal` and relevant Enterprise READMEs MUST describe both Planet model choices, pricing, and managed usage charges.
- **FR-012**: The two delivery parts MUST be committed separately on the same branch, with the BYOK audit/fix first and the priced option second.
- **FR-013**: No database migration is expected; if discovery proves one necessary it MUST use migration number 221.

### Key Entities

- **Plan Catalog Entry**: The source-of-truth plan id, display price, model mode, managed-model rate, quotas, and allowances consumed by billing and policy code.
- **Managed Model Policy**: The workspace-to-plan decision that authorizes or refuses platform-managed credentials.
- **Workspace Provider Credential**: A tenant-configured provider secret eligible for BYOK resolution.
- **Stripe Catalog Price**: A lookup-keyed monthly or yearly price derived from a plan catalog entry.

## Success Criteria

### Measurable Outcomes

- **SC-001**: With platform environment keys configured, zero BYOK-without-keys capability resolutions return a platform credential across all audited model and embedding consumers.
- **SC-002**: Automated tests fail if a BYOK plan can receive a platform-managed model or embedding client.
- **SC-003**: `planet_managed` is available through the public plans response, billing UI, checkout mapping, webhook mapping, and Stripe sync plan with no new plan-specific billing branch.
- **SC-004**: Every quota and allowance field other than model mode, base price, and managed usage pricing is equal between Planet and `planet_managed`.
- **SC-005**: Changed-module tests, required typechecks, lint, dead-code checks, Enterprise build, frontend checks, and applicable documentation build/corpus sync pass or have an explicitly reported pre-existing baseline failure.

## Assumptions

- Catalog monetary values are integer cents and the annual price represents ten months, matching the existing plan convention.
- Satellite is the authoritative source for the €0.05 managed-model conversation rate.
- The existing unavailable-provider UI/state is reused rather than introducing new assistant copy.
- Billing checkout and webhook behavior should remain driven by catalog metadata and Stripe lookup keys.
- No OpenAPI shape changes are required unless current plan-id schemas enumerate plan ids outside the catalog-derived contract.

