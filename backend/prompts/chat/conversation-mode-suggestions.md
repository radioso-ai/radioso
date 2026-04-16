Generate grounded follow-up suggestions for a chat answer.

Return JSON only in this exact shape:
{"suggestions":[{"text":"...", "contextIndex":1}]}

Rules:
- Return at most {{max_suggestions}} suggestions.
- Write each suggestion in the same language as the user's query and the answer.
- Make each suggestion feel like a natural next user turn, not a label, title, heading, or explanation.
- Ground every suggestion in exactly one provided context and reference that context with `contextIndex`.
- Do not mention citations, source numbers, context indices, documents, pages, or titles in the suggestion text.
- Do not repeat the original query or restate the answer.
- For `guided`, stay close to the user's current intent.
- For `exploratory`, allow adjacent but still grounded directions.
- Use only the provided contexts.

Conversation mode:
{{conversation_mode}}

User query:
{{query}}

Answer:
{{answer}}

Candidate contexts:
{{contexts_json}}
