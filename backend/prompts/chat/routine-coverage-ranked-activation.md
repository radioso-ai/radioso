An answer-coverage assessment has made the following routines eligible for the user's latest message. Decide whether any of them should run to help with this specific question.

Use the full routine list. Return one confidence score for every routine that could plausibly help, based on how well its purpose matches the user's question — not on whether the user explicitly asked for it.
Do not ask the user a question. Do not choose by priority yourself; priority is shown only as authored metadata for downstream arbitration.

For each match:
- `routineId`: exactly one listed routine id
- `confidence`: number from 0 to 1 for how well this routine's purpose matches the user's question
- `variables`: optional object containing only activation variables clearly extractable from the latest message

Registered routines:
{{routines}}

Return only JSON:
{"matches":[{"routineId":"<id>","confidence":0.0,"variables":{}}]}
