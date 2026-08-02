# Content Planning Module

Content Planning owns the continuously maintained operator projection of visitor
interests, grounding gaps, and evidence-backed content actions. It observes committed
turn metadata after the answer is durable; it never delays or changes the visitor's
answer.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).

## Boundaries

Chat owns interaction interpretation and the neutral committed-turn envelope.
Retrieval owns semantic-search vectors. Quality owns the answer population, grounding,
triage, and Eval verification semantics. Content Planning consumes narrow ports from
all three; none of those modules imports topic, ranking, or recommendation rules.

Source wording remains message-owned. Projection rows retain source identifiers,
non-reversible hashes, vector envelopes, memberships, scalar evidence, and bounded
generated operator prose. Representative questions and enrichment samples are loaded
through authorized message reads, so message deletion removes the text immediately.

PostgreSQL is the queue and system of record. The worker claims bounded vector,
projection, reconciliation, and enrichment work with leases and revision fences.
Application composition assembles repositories, provider adapters, observability, and
worker lifecycle; it does not own content-planning policy.

The read model uses a fixed rolling 30-day current window and the preceding 30 days for
comparison. Ranking, credible-opportunity eligibility, action selection, clustering,
maturity, and enrichment scheduling are versioned backend policies. The frontend
renders these decisions and must not reproduce them.

## Public Surfaces

- `composition.ts`: the narrow exported HTTP/read contracts and route factory.
- `contracts/index.ts`: public DTOs and Zod schemas.
- `contracts/persistence.ts`: internal persistence ports and bounded record shapes.
- `routes.ts`: session authorization and request validation for
  `/api/v1/quality/content-plan`.
- `worker.ts`: bounded asynchronous projection lifecycle entry point.

## Read First

- `domain/observationEligibility.ts`: which interpreted turns become observations.
- `domain/topicPolicy.ts` and `domain/incrementalClustering.ts`: assignment, maturity,
  centroid, merge, redirect, and retention rules.
- `domain/aggregationPolicy.ts`: rolling-window counts and grounding denominators.
- `domain/opportunityPolicy.ts`: credible gaps, canonical ordering, and deterministic
  actions.
- `services/observationIntakeService.ts`: content-free committed-turn registration.
- `services/contentPlanReadService.ts`: authorized list/detail/member-turn assembly.
- `services/corpusEvidenceService.ts`: bounded related-document evidence.
- `services/enrichmentScheduler.ts` and `services/enrichmentProcessor.ts`: material
  changes, debounce, provider work, retries, and revision-fenced publication.
- `infra/contentPlanReadSource.ts`: bounded Postgres report reads.

## Tests

```bash
cd backend
pnpm exec vitest run tests/unit/content-planning-*.test.ts
pnpm exec vitest run tests/integration/content-planning-*.integration.test.ts
pnpm run lint:boundaries
```

The committed multilingual clustering fixture is under
`tests/fixtures/content-planning/`. Public contract changes also require
`pnpm run check:api-contracts`.
