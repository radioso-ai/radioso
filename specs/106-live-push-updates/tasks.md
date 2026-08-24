# Tasks: Live push updates robustness hardening

**Inputs**: `spec.md`, `plan.md`, and the implemented live-push diff against `origin/main`

## Phase 1 — Backend correctness (Terra, tests first)

- [x] T001 Add failing class-backed ownership-decorator tests that exercise every wrapped method
  and detect an unbound repository receiver.
- [x] T002 Add failing commit/rollback tests proving ownership hints appear only after commit and
  are absent after rollback.
- [x] T003 Preserve repository receivers and move transactional ownership publication to a
  post-commit seam.
- [x] T004 Add failing stress/recovery tests for workspace-proportional dispatch, bounded/coalesced
  publication, slow publishing, and listener-loss subscriber termination.
- [x] T005 Add a failing runtime test proving an open SSE stream does not block API shutdown.
- [x] T006 Implement workspace-indexed subscribers, a bounded/coalesced publisher, reconnect
  resynchronization, and non-per-frame telemetry.
- [x] T007 Make SSE writes respect response backpressure and order shutdown so the bus terminates
  streams before awaiting the HTTP server.
- [x] T008 Add failing crawl tests for continuation release, no-op checkpoint updates, and
  lightweight/bounded bulk recovery publication.
- [x] T009 Publish every rendered crawl transition and make bulk recovery allocation bounded.

## Phase 2 — Frontend convergence (Luna, tests first)

- [x] T010 Add fake-timer tests showing sustained sub-window events still refetch at a bounded
  cadence and version-dedupe state is bounded to a window.
- [x] T011 Add tests for disabled/unauthorized terminal responses, unstable reconnects, listener
  cleanup, and reconnect reconciliation.
- [x] T012 Add overlapping-request tests proving stale History and Documents responses cannot win
  and duplicate invalidations do not create unbounded concurrent requests.
- [x] T013 Replace trailing debounce with fixed-window dirty coalescing and harden reconnect state.
- [x] T014 Add single-flight, queued trailing reruns, stale-response guards, and change-kind-specific
  refetching to the covered data hooks.

## Phase 3 — Integration and gates (coordinator)

- [x] T015 Run focused backend and frontend live-push test suites.
- [x] T016 Run the complete frontend suite and relevant backend build/type/test gates.
- [x] T017 Run `pnpm run ci:local -- origin/main` and record any unrelated failures separately.
  The gate reached 141/142 passing integration files, then stopped on the unchanged
  `mcp-converse-session-revalidation.integration.test.ts` (expected 403, received 404).
- [x] T018 Review the final diff for transaction safety, bounded resource use, payload privacy,
  observability, API/SDK drift, and worker/AMQP contract impact.
