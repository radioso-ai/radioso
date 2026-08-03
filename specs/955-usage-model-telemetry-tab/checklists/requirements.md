# Specification Quality Checklist: Model and Embedding Usage Visibility

**Purpose**: Validate that the detailed AI-usage feature is complete, bounded, testable, and ready for technical planning.
**Created**: 2026-08-03
**Feature**: [Model and Embedding Usage Visibility](../spec.md)

## Content Quality

- [x] CHK001 The problem, primary users, and user value are stated clearly.
- [x] CHK002 The specification separates end-user message usage from internal operations.
- [x] CHK003 The specification identifies metadata generation, embeddings, operator test chat, evals, agent creation, and directive analysis without making the list closed.
- [x] CHK004 The feature has explicit in-scope and out-of-scope behavior.

## Requirement Completeness

- [x] CHK005 All functional requirements are testable and unambiguous.
- [x] CHK006 UI tasks cover tabs, filters, tables, pagination, unavailable values, and loading/error/empty states.
- [x] CHK007 Authorization, account/workspace scoping, and privacy boundaries are explicit.
- [x] CHK008 Reasoning-token availability and historical-data behavior are explicit.
- [x] CHK009 Message-queue impact is reviewed and declared out of scope.
- [x] CHK010 No clarification markers remain.

## Architecture and Delivery Readiness

- [x] CHK011 Module ownership, ports, dependency direction, and anti-goals are stated.
- [x] CHK012 Durable job and cross-document batch grouping are explicitly deferred.
- [x] CHK013 Backend TDD, frontend browser coverage, OpenAPI, generated artifacts, and documentation updates are required.
- [x] CHK014 Success criteria are measurable and verify privacy as well as visible behavior.
- [x] CHK015 Durable event kind, aggregation-before-pagination, exact message classification, and reasoning coverage are specified.
- [x] CHK016 Directive-coherence attribution is included so that named internal usage is recordable rather than silently dropped.
- [x] CHK017 The response field allowlist excludes unsafe ledger identifiers and error detail in addition to customer content.
- [x] CHK018 Message-linked embeddings have a separate subtotal and do not distort model reasoning coverage.
- [x] CHK019 Ambiguous historical ledger rows retain an explicit unknown classification instead of a guessed model/embedding type.

## Notes

- The requestor explicitly chose not to introduce durable job/batch grouping in this feature.
- The current workspace branch is intentionally retained; the specification directory uses the next globally available numeric feature identifier.
- Independent review findings were incorporated before the specification was approved for implementation.
