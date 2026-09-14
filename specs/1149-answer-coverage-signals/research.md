# Research: Answer Coverage Signals

## Decisions

- **Shared contract location:** `packages/conversation-contract` owns the runtime
  value types consumed by the engine and backend. Backend `answerCoverage` owns
  Zod validation, model adaptation, persistence ports, and composition wiring.
  This prevents engine/backend duplicate structural types.
- **Diagnostic association:** extend the existing immutable recorded turn trace
  and history projection with the assessment correlation. Add durable storage
  only where the existing recorded diagnostic/history path cannot preserve
  assessment and reaction records across retries and Pulse reads.
- **Producer timing:** retrieval/evidence completes first; assessment is obtained
  and injected into composition context before stream creation or non-stream
  composition. Any invalid/failed assessment retains normal safe behavior but
  cannot trigger coverage rules.
- **Persistence:** migration 171 stores immutable assessments and reaction traces
  through the repository port → Kysely adapter. The originating-request key
  makes retries reuse the recorded assessment; the evaluation marker separates
  no evaluation from an evaluated no-match. Migration 172 stores validated
  directive and routine criteria.
- **Outcome presentation:** assessed partial, unanswered, unclear, and
  unavailable turns use distinct `coverage_*` outcomes. They do not convert an
  actual execution result or retrieval refusal into `no_context_refusal`.
- **Pulse:** consume the recorded history source projection and preserve its
  grounding signal; coverage is a parallel semantic signal, not a replacement.

## Rejected alternatives

- Citation count/retrieval score rules cannot represent the visitor's contextual
  request and violate FR-004.
- A backend-local engine type would duplicate a cross-package contract.
- Recomputing coverage while rendering debug/Pulse would manufacture historical
  verdicts and violate FR-006/019.

## Queue impact

No document-worker dispatch, AMQP payload, retry semantics, queue tests, or
queue documentation changes are expected because assessment and reporting stay
inside the synchronous turn/history path. Validate this again against concrete
call sites before release.
