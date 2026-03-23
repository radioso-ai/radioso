# Quickstart: Retrieval Trace Graph

## 1. Prepare

1. Work in [/Users/dm/conductor/workspaces/radioso/auckland](/Users/dm/conductor/workspaces/radioso/auckland) on branch `025-retrieval-trace-graph`.
2. Review the approved spec, plan, research, data model, contract note, and quickstart artifacts in [/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph](/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph).
3. Confirm backend changes will follow TDD before implementation starts.

## 2. Implement Backend First

1. Add failing backend unit tests for the new retrieval trace domain types and trace-assembly behavior from staged retrieval results.
2. Add failing backend unit tests for bounded stage shaping, including skip, fallback, rejection, unavailable, and no-context answer outcomes.
3. Add failing backend service tests proving `chatService.ts` returns both `retrievalInfo` and additive `retrievalTrace` on JSON and streaming completion paths.
4. Add failing backend history-service tests proving stored trace metadata is replayed for assistant messages and older history items show a clear unavailable state.
5. Add failing backend contract tests for additive response fields in runtime OpenAPI-backed chat and history payloads.
6. Implement retrieval trace domain types, assembly services, chat-service wiring, history-service replay, and code-first OpenAPI updates until backend tests pass.

## 3. Implement Frontend

1. Extend frontend API types and chat contexts to carry additive `retrievalTrace` data without breaking existing `retrievalInfo` use.
2. Build reusable retrieval-trace graph and detail components for operator diagnostics.
3. Add the trace surface to the live chat experience while preserving the current compact retrieval summary.
4. Add the trace surface to chat-history detail for historical assistant answers, including an explicit unavailable state for older messages.
5. Add raw trace inspection for support workflows without making it the default presentation.

## 4. Verify

1. Execute representative queries that produce normal, skipped, fallback, rejected, and no-context retrieval paths.
2. Confirm the live chat answer exposes both compact summary data and the richer trace.
3. Confirm streaming and non-streaming chat completions return equivalent trace information.
4. Confirm chat history replays the stored trace for new answers and shows a clear unavailable state for older answers without trace data.
5. Confirm the graph shows branch participation for semantic and lexical retrieval where applicable and converges cleanly into later stages.
6. Confirm the raw trace matches the graph and does not contain prohibited sensitive content.
7. Re-run existing retrieval-summary, citation, and no-context flows to verify no regression in the current operator experience.

## 5. Finish

1. Regenerate OpenAPI outputs from the code-first registry after schema updates.
2. Run the relevant backend unit, contract, and integration suites plus targeted frontend verification.
3. Proceed to task breakdown only after the design artifacts still match the approved spec and the implementation plan.
