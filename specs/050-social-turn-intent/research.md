# Research: Model-Level Social Turn Intent

## Decision 1: Reuse the existing query-interpretation model call for response intent

**Decision**: Extend the existing query rewrite interpretation contract so the
same model pass also classifies whether the current turn is `retrieval`,
`social_only`, or `assistant_identity`.

**Rationale**:

- The user explicitly preferred adding one system-level intent and asking query
  rewrite to recognize it.
- The existing rewrite prompt already sees conversation context and already
  resolves continuation versus fresh-subject behavior, so it has the right
  context to decide whether a turn is purely social or actually contains a real
  grounded ask.
- A second classifier call would add latency and create drift risk between the
  retrieval interpretation and the response-routing interpretation.

**Alternatives considered**:

- Add a separate model classifier before retrieval:
  rejected because it adds another LLM round-trip and risks disagreement with
  the rewrite pass.
- Add local keyword or regex routing:
  rejected because the user explicitly prohibited deterministic keyword or
  regex intent recognition.

## Decision 2: Preserve answer-shaping instructions through a shared builder

**Decision**: Extract the assistant identity, custom instruction,
conversation-mode instruction, and response-language instruction logic from the
retrieval prompt path into a shared answer-instruction builder that both
retrieval-backed and non-retrieval prompts can use.

**Rationale**:

- Today those instructions are assembled in the retrieval prompt builder, so a
  non-retrieval social or identity path would otherwise silently lose them.
- Copying the same logic into chat orchestration would create prompt drift and
  violate the spec’s boundary rule.
- Reusing the exact same instruction builder keeps operator-facing answer
  guidance consistent across grounded and non-grounded turns.

**Alternatives considered**:

- Keep the instruction logic only inside `promptBuilder.ts` and let social
  replies skip it:
  rejected because the approved spec requires those instructions to remain
  accessible on the non-retrieval path.
- Reuse the full retrieval answer prompt for social replies with fake empty
  context:
  rejected because the retrieval prompt contains citation and grounded-answer
  rules that are not appropriate for social-only or identity-only replies.

## Decision 3: Keep the non-retrieval shortcut chat-specific

**Decision**: Use the new response-intent classification in chat flows and keep
retrieval-only consumers such as document search on the existing retrieval path
unless they opt in separately.

**Rationale**:

- `RetrievalPipelineService.run()` is used outside chat, including document
  search. A global non-retrieval shortcut would create behavior
  changes in those callers that are outside this feature’s scope.
- Chat is the only workflow where greetings, thanks, and identity turns are a
  first-class product problem.
- A chat-specific routing seam keeps the feature local while still reusing the
  shared interpretation result.

**Alternatives considered**:

- Change every retrieval pipeline caller to honor `social_only`:
  rejected because it broadens scope to non-chat surfaces with different user
  expectations.
- Ignore response intent completely in retrieval diagnostics:
  rejected because the approved spec requires engineers to be able to tell that
  retrieval was intentionally skipped.

## Decision 4: Record routing in additive diagnostics and audit metadata

**Decision**: Record the chosen response path additively in chat diagnostics and
audit metadata instead of introducing a new endpoint or standalone debug store.

**Rationale**:

- The feature needs inspectability but does not justify a new transport surface.
- The chat stack already records additive metadata for answer outcomes,
  conversation modes, and rewrite continuity state.
- Additive metadata is sufficient for reviewers and support engineers to see
  whether a turn used social-only, assistant-identity-only, or normal retrieval
  routing.

**Alternatives considered**:

- Add a new API field dedicated to social intent diagnostics:
  rejected because it changes public chat contracts unnecessarily.
- Rely only on logs:
  rejected because the spec requires durable, inspectable routing evidence.
