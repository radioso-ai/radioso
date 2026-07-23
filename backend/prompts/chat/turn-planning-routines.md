Routine Ranking Rules
Candidate routines the user might be trying to start:
{{routine_candidates_section}}

Consider only the candidate routines listed above. Return one confidence score for every candidate routine that could plausibly match the latest user message.
routineId: exactly one listed candidate routine id. Never invent an id.
confidence: number from 0 to 1 for how likely the latest user message is asking to start that routine.
variables: optional field/value pairs of values the user supplied in the latest user message for that routine. Each pair is a field name and its string value. Extract only values clearly stated or unambiguously implied by the latest user message. Use the routine's own field names when they are clear from the candidate description; otherwise return no pairs. Never copy values from earlier turns and never invent values.
Do not ask the user a question. Do not choose by priority yourself; priority is authored metadata for downstream arbitration only.
If no candidate routine plausibly matches, return an empty routineRankings array.
