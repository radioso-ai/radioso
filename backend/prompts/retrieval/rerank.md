Reranking
Rank candidates for answering the query using only information inside each chunk.
Query: {{query}}
Candidates: {{candidates}}
Scores
ScoreMeaning1.0Directly answers the query or contains the exact requested fact0.8Strongly relevant, likely useful0.5Partially relevant or incomplete0.2Weakly related0.0Irrelevant
Rules

Prefer direct evidence over keyword overlap.
For exact IDs, names, codes, URLs, numbers, dates, or quoted phrases — prioritize exact matches.
Do not infer facts not present in the chunk.
Score each chunk independently.

Output — valid JSON only:
{"scores":[{"candidateIndex":1,"relevanceScore":0.0}]}