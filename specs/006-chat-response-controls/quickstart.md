# Quickstart: Chat Response Controls

## 1. Prepare

1. Work on branch `006-chat-response-controls`.
2. Review the approved spec, plan, research, and contract artifacts in `/Users/dm/code/hivec/specs/006-chat-response-controls/`.
3. Confirm backend changes will follow TDD before implementation begins.

## 2. Implement Backend First

1. Add failing backend tests for response settings validation and persistence.
2. Add failing backend tests for chat answer policy:
   - warmth preference affects answer style inputs
   - answers do not end with engagement questions when sufficient context exists
   - clarification questions remain allowed when required
3. Add failing backend tests for optional citation behavior:
   - citations may be omitted cleanly
   - duplicate source references collapse
   - streaming and non-streaming completion payloads match
4. Implement persistence, prompt-policy, citation-assignment, and transport changes until backend tests pass.

## 3. Implement Frontend

1. Update settings data types and API handling for the new response controls.
2. Add the warmth slider and citation-display control to settings.
3. Update chat state and rendering to consume backend-owned `answerSegments` metadata when present.
4. Remove positional citation heuristics from the existing renderer.

## 4. Verify

1. Save settings and confirm they reload correctly.
2. Send the same question at low and high warmth settings and compare tone.
3. Verify fully specified questions do not end with engagement prompts.
4. Verify ambiguous questions still produce clarification questions.
5. Verify citation markers are clean and deduplicated when enabled.
6. Verify the same answer renders correctly without citation markers when disabled.
7. Verify streaming and non-streaming responses converge to the same final content.

## 5. Finish

1. Update API documentation and any relevant examples.
2. Run the relevant backend test suites and frontend lint.
3. Proceed to task breakdown only after the design artifacts still match the approved spec.
