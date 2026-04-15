# Quickstart: Conversational Unsupported Answers

## Scenario 1: Fully unsupported answer with related retrieved material

1. Start the backend in test or local mode.
2. Ingest a document such as `Guide` with content about testing and parsing.
3. Force the chat model to answer with unsupported content like `It also offers
   24/7 phone support.` while retrieval still returns the `Guide` context.
4. Send a chat request under the default `strict` answer-support policy.
5. Confirm the final answer:
   - explicitly says the requested answer could not be supported from the
     workspace material
   - offers an adjacent grounded direction based on the retrieved material
   - does not present the unsupported claim as fact

## Scenario 2: Fully unsupported answer with no honest adjacent suggestion

1. Ingest a document whose title/content gives no safe adjacent direction for
   the user query.
2. Force a fully unsupported strict-mode answer.
3. Send a chat request.
4. Confirm the final answer is a concise conversational miss and does not invent
   a topic pivot.

## Scenario 3: No-context response

1. Use a workspace with no relevant documents for the user query.
2. Send a chat request such as `What is the capital of France?`
3. Confirm the final answer:
   - explicitly says the supporting material was not found in the workspace
   - is more conversational than the old hard-coded refusal
   - does not imply that the system answered from outside the workspace

## Scenario 4: Diagnostics and history remain stable

1. Run one fully unsupported strict-mode turn and one no-context turn.
2. Fetch chat history or inspect the recorded audit metadata.
3. Confirm the outcome values remain:
   - `grounded_degraded_unsupported_segments` for the fully unsupported strict
     turn
   - `no_context_refusal` for the no-context turn

## Scenario 5: Eval replay matches live behavior

1. Run an eval replay case with no contexts.
2. Run an eval replay case with retrieved contexts plus a fully unsupported
   answer draft.
3. Confirm both use the same conversational miss behavior as the live chat
   service.
