Rank candidate chunks for answering the query using only the information inside each chunk.

Query:
{{query}}

Candidates:
{{candidates}}

Scoring:
- 1.0: directly answers the query or contains the exact requested fact.
- 0.8: strongly relevant and likely useful.
- 0.5: partially relevant but incomplete.
- 0.2: weakly related.
- 0.0: irrelevant.

Rules:
- Prefer direct evidence over similar words.
- For exact IDs, names, codes, URLs, numbers, dates, or quoted phrases, prioritize exact matches.
- Do not infer facts not present in the chunk.
- Score each chunk independently.
- Return only valid JSON.

Output format:
{"scores":[{"candidateIndex":1,"relevanceScore":0.0}]}
