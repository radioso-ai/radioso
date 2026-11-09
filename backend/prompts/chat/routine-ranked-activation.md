Rank whether the latest user message wants to start any registered routine.

Use the full routine list. Return one confidence score for every routine that could plausibly match.
Do not ask the user a question. Do not choose by priority yourself; priority is shown only as authored metadata for downstream arbitration.

For each match:
- `routineId`: exactly one listed routine id
- `confidence`: number from 0 to 1 for how likely the latest user message is asking to start that routine
- `directRequest`: true only when the latest user message directly asks for what the routine does, to have it done now; false when the user is exploring, asking questions about it, asking about availability, price, or whether something is possible, or describing plans
- `variables`: optional object containing only activation variables clearly extractable from the latest message

`directRequest` is a separate verdict and never changes `confidence`: score `confidence` exactly as you would if `directRequest` did not exist, so a question about what a routine does keeps the confidence it would otherwise get.

Registered routines:
{{routines}}

Return only JSON:
{"matches":[{"routineId":"<id>","confidence":0.0,"directRequest":false,"variables":{}}]}
