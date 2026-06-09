# Fix Review 3 Notes

## P1 Tool Steps

- Routine validation now rejects authored `tool` steps with `unsupported_tool_step`.
- The author-facing diagnostic says tool steps are not yet supported and cannot be published until routine tool dispatch is available.
- The frontend step-kind selector no longer offers `tool`; existing inert tool-form handling remains only for already-loaded data.
- Real `ConversationRoutineSkillDispatcher` production wiring is intentionally deferred to a separate feature.

## P2a Always Guards

- `RoutineGuard` now includes `{ kind: "always" }`.
- The routine compiler maps authored `guardKind: "always"` to a deterministic guard.
- The runner evaluates `always` before selector fallback, so unconditional transitions advance without consulting the LLM selector.
- Legacy absent/`llm` transitions still use the selector.

## P2b Attempts Persistence

- The transactional assistant-turn persistence path now inserts and updates `routine_states.attempts`.
- Attempts are serialized from `state.attempts ?? {}` to match `RoutineStateRepository.save`.

## Verification

- Focused backend routine tests passed.
- Conversation engine package tests passed.
- Conversation defaults package tests passed.
- Backend typecheck passed.
- Backend dependency-boundary lint passed.
- API contract artifacts are current.
- Frontend lint and routine unit tests passed.
- The broad backend Vitest command was run, but this sandbox denies Supertest socket binding with `listen EPERM: operation not permitted 0.0.0.0`; the failure is systemic across DB/API route tests rather than isolated to these changes.
