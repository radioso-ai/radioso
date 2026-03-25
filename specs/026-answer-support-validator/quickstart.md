# Quickstart: Answer Support Validator

## 1. Prepare

1. Work in [/Users/dm/conductor/workspaces/radioso/validator-enforcement](/Users/dm/conductor/workspaces/radioso/validator-enforcement) on branch `026-answer-support-validator`.
2. Review the approved spec, plan, research, data model, contract note, and tasks in [/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator](/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator).
3. Confirm backend TDD is followed: tests first, failing before implementation.

## 2. Implement Backend First

1. Add failing unit tests for answer-segment support classification, non-substantive detection, unsupported notice replacement, and final citation retention.
2. Add failing chat-service tests for:
   - mixed-support non-stream responses
   - fully supported answers
   - fully unsupported drafted answers
   - streaming delivery that emits only validated text
3. Add failing integration tests for persisted degraded outcomes and no-context refusal classification.
4. Add failing contract/history tests for additive validation debug fields.
5. Implement the validator seam, outcome classifier, prompt guidance, chat-service wiring, and history debug mapping until the backend suites pass.

## 3. Verify Behavior

1. Ask a mixed-support question and confirm the final answer preserves only supported content plus explicit unsupported notice text.
2. Ask a grounded question and confirm the answer remains unchanged and is recorded as `grounded_success`.
3. Force an unsupported drafted answer that still reaches validation and confirm the final answer contains only the unsupported notice.
4. Ask a no-context question and confirm the existing refusal remains distinct from validator-triggered degradation.
5. Fetch chat history detail and confirm assistant-message debug shows `answerOutcome` and validation counts.
6. Confirm persisted assistant-message content never contains replaced unsupported substantive text.

## 4. Finish

1. Regenerate OpenAPI outputs from the code-first registry if history debug schemas changed.
2. Run relevant backend unit, integration, and contract suites plus backend build verification.
3. Re-read the spec against the shipped behavior before review handoff.
