# Quality Module

Quality owns the **operator's read-only view of how well the agent answers**:
which turns are worth reviewing, what state an operator has put them in, and the
rates those turns add up to. Start here when a feature changes what counts as a
quality problem, how a signal is counted, or what the Activity → Quality surface
reads.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).

## Boundaries

This module **reads and triages; it never influences a turn**. Nothing here
feeds retrieval, routing, or answer composition. It owns no writes except the
operator's triage state.

The definition of a quality signal is a **domain concern, not a client
concern**. `domain/qualitySignals.ts` resolves each `QualitySignalId` to a
predicate from structured skill-catalog metadata. It knows what a signal means;
it does not know SQL. The query layer decides how a predicate becomes a
statement. Signal meaning is never expressed as keyword or outcome-name
matching, so it stays correct across locales and as skills evolve.

`GET /quality/turns` takes one signal or several, and several means **any of
them**: the per-signal predicates are OR-ed into a single clause, which is then
AND-ed with the explicit filters. Every predicate is a scalar test or a
correlated `EXISTS` over the row already in scope, so a turn carrying two
signals is still exactly one row — a join or `UNION ALL` per signal would list
it twice. This is what lets the dashboard queue ask for "anything worth
reviewing" and a chip ask for one signal through the same parameter.

Claim-level grounding detail is a separate immutable message snapshot. Quality
reads only the five dedicated `messages.grounding_*` columns and exposes a
complete object or `null`; it never reconstructs diagnostics from message or
audit JSON. `groundingDiagnostic.ts` owns row mapping and scalar predicates.
Verdicts are OR-ed within their list, then AND-ed with count-presence and all
other filters.

Grounding derives from the catalog's `groundedAnswer` flag. **An absent flag is
not `false`.** An outcome such as a clarifying question deliberately omits the
flag: it neither grounded an answer nor failed to, so it belongs to neither the
numerator nor the denominator of the grounded rate.

`/quality/turns` and `/quality/stats` **must select from one turn population**.
`turnPopulationSql.ts` owns that predicate: assistant role, workspace scope, the
conversation join, and the exclusions for operator-test channels and
human-authored replies. Both readers build on it. A predicate that differs
between them would make a signal's count disagree with the rows behind it, which
is the failure this module exists to prevent. Both exclusions are NULL-safe;
that is load-bearing, since `NOT IN` yields NULL rather than TRUE for a NULL
column and would silently drop real turns.

Rates are reported with the population they are measured over, and report `null`
rather than a number when that population is empty. Backlog counts are all-time
and ignore the health window, so an untriaged turn never disappears because it
aged out.

## Public Surfaces

- `composition.ts`: the service, the route factory, the signal domain helpers,
  and the DTOs. Application composition wires the skill catalog in through
  `infra/skillCatalogOutcomeSource.ts`.
- `contracts/index.ts`: the two ports (`QualityTurnsServicePort`,
  `QualityStatsServicePort`) and every response shape.

## Read First

- `domain/qualitySignals.ts`: what each signal means, and the narrow catalog port
  it needs.
- `turnPopulationSql.ts`: the shared turn population and the query fragments both
  readers compose.
- `statsQuery.ts`: pure window maths, UTC day bucketing, and the aggregate query
  builders. Returns `{text, params}`; runs no I/O.
- `service.ts`: runs the builders and maps rows to DTOs.
- `routes.ts`: Zod validation and permission wiring.
- `infra/skillCatalogOutcomeSource.ts`: adapts the skill catalog to the narrow
  outcome view. Keeps entries the capability policy marks `forbidden`, because a
  turn that already ran still belongs in the denominator.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/quality-signals.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/quality-stats-query.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/quality-routes.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/quality-stats.integration.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/quality-turns.integration.test.ts`
