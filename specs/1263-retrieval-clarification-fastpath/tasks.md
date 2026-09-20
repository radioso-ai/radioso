# Tasks: Retrieval Clarification Label Reuse

- [x] T001 Add failing `SenseGroupingService` tests proving an actual repeated non-exclusive assessment skips `labelGateway.label` across fresh diagnostic IDs, while normal structural no-call behavior remains unchanged.
- [x] T002 Add failing cache-safety tests for incomplete/exclusive/duplicate/error responses, key changes, expiry, and capacity.
- [x] T003 Add the private bounded TTL/LRU reuse path and opaque resolved-scope capability to `senseGroupingService.ts`, preserving all existing grouping and fallback behavior.
- [x] T004 Run focused tests, backend build, lint, and dead-code checks; record evidence in `.context/`.
- [x] T005 Run the isolated local benchmark and record cache-outcome cohort counts. Result: validation completed, but zero reuse hits meant no performance improvement was demonstrated.
# Reverted / superseded

The implementation described by these tasks was removed after the local benchmark
produced no eligible reuse hits and no demonstrated latency benefit. This file is
> retained as experiment history; see `.context/input-token-caching-benchmarks/`.
