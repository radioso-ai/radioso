Rank whether the latest user message wants to start any registered routine.

Use the full routine list. Return one confidence score for every routine that could plausibly match.
Do not ask the user a question. Do not choose by priority yourself; priority is shown only as authored metadata for downstream arbitration.

For each match:
- `routineId`: exactly one listed routine id
- `confidence`: number from 0 to 1 for how likely the latest user message is asking to start that routine
- `variables`: optional object containing only activation variables clearly extractable from the latest message

Registered routines:
{{routines}}

Return only JSON:
{"matches":[{"routineId":"<id>","confidence":0.0,"variables":{}}]}
