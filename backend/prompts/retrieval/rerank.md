Reranking
Rank candidates for answering the query using only information inside each chunk.
Today's date is {{today}}.
Query: {{query}}
Candidates: {{candidates}}
Scores
ScoreMeaning1.0Directly answers the query or contains the exact requested fact0.8Strongly relevant, likely useful0.5Partially relevant or incomplete0.2Weakly related0.0Irrelevant
Rules

Prefer direct evidence over keyword overlap.
For exact IDs, names, codes, URLs, numbers, dates, or quoted phrases — prioritize exact matches.
When a chunk describes a time-bound event, read the event's date from the chunk and judge recency against today's date: prefer events that are upcoming or ongoing, and lower events that have clearly already passed — unless the query explicitly asks about a past period. Use only dates found in the chunk; today's date is the reference point, not a fact to add.
Do not infer facts not present in the chunk.
Score each chunk independently.

Output — valid JSON only:
{"scores":[{"candidateIndex":1,"relevanceScore":0.0}]}