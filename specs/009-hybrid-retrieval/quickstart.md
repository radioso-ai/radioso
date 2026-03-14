# Quickstart: Hybrid Retrieval

## 1. Prepare

1. Work in [/Users/dm/code/hivec-hybrid-retrieval](/Users/dm/code/hivec-hybrid-retrieval) on branch `009-hybrid-retrieval`.
2. Review the approved spec, plan, research, contract, and data-model artifacts in [/Users/dm/code/hivec-hybrid-retrieval/specs/009-hybrid-retrieval](/Users/dm/code/hivec-hybrid-retrieval/specs/009-hybrid-retrieval).
3. Confirm backend work will follow TDD before implementation begins.

## 2. Implement Backend First

1. Add failing backend tests for retrieval-settings validation and persistence of supported attribute-family controls.
2. Add failing backend tests for ingest-time `searchText` rendering and deterministic supported attribute extraction and normalization.
3. Add failing backend tests for PostgreSQL lexical candidate generation, hybrid candidate deduplication by chunk id, and bounded candidate counts.
4. Add failing backend tests for supported query-constraint parsing, confidence thresholds, hard-filter gating, boost-only behavior, and fallback degradation.
5. Add failing backend tests for retrieval-information payload shaping on both JSON chat responses and streaming completion payloads.
6. Add failing backend contract and benchmark tests for exact-match, mixed-signal, constraint-heavy, fallback, and regression scenarios.
7. Implement migrations, settings, retrieval-domain seams, lexical search, attribute-aware scoring, and additive chat payloads until backend tests pass.

## 3. Implement Frontend

1. Update retrieval settings API types to include supported attribute-family controls.
2. Add settings controls for `date_point`, `date_range`, `money_value`, and `location`, including `enabled` and `mode` behavior.
3. Add a retrieval-information view to the admin chat experience using the additive chat response metadata.
4. Preserve the existing answer and citation flow; retrieval information should be bounded, readable, and secondary to the answer itself.

## 4. Verify

1. Save retrieval settings with different attribute-family modes and confirm they round-trip correctly for one account without affecting another.
2. Ingest representative content containing dates, date ranges, prices, and locations and confirm normalized values persist consistently.
3. Verify legacy chunks without `search_text` or structured attributes still retrieve safely via `content` fallback and empty-attribute defaults.
4. Reindex or re-save existing documents after rollout so older chunks gain normalized `searchText` and structured attributes; the fallback path is safe, but hybrid quality improves only after backfill.
5. Run exact-match and mixed-signal queries and confirm lexical retrieval contributes relevant candidates when semantic retrieval alone would miss them.
6. Run constraint-heavy queries and confirm high-confidence filters narrow results correctly while low-confidence cases degrade to boosts.
7. Force an over-constrained query and confirm fallback relaxes hard filters without silently failing.
8. Open the retrieval-information view in the admin chat experience and confirm parsed intent, candidate counts, applied constraints, rerank status, and fallback usage match the executed query.
9. Re-run the existing no-context and citation flows to confirm current fallback answers and citations remain intact.

## 5. Finish

1. Update contract documentation and examples for retrieval settings and additive chat response payloads.
2. Run the relevant backend unit, contract, integration, and benchmark suites plus targeted frontend verification.
3. Proceed to task breakdown only after the design artifacts still match the approved spec and the implementation plan.
