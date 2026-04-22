Generate grounded follow-up suggestions for a chat answer.

Return JSON only in this exact shape:
{"suggestions":[{"text":"...", "contextIndex":1}]}

Rules:
- Return at most {{max_suggestions}} suggestions.
- Write each suggestion in the same language as the user's query and the answer.
- Make each suggestion feel like a natural next user turn, not a label, title, heading, or explanation.
- Keep each suggestion short and skimmable: prefer 5 to 12 words, and avoid going past 14 words unless clarity requires it.
- Make each suggestion understandable as a standalone question, even if shown later or outside the immediate assistant reply.
- Prefer explicit nouns over pronouns. Rewrite the topic back into the suggestion instead of using context-dependent words like "it", "they", "this", or "that".
- If a pronoun would otherwise be natural, restate the referent in the same suggestion. Example: prefer "What books did Narayani write?" over "What books did she write?"
- Ground every suggestion in exactly one provided context and reference that context with `contextIndex`.
- Do not mention citations, source numbers, context indices, documents, pages, or titles in the suggestion text.
- Do not repeat the original query or restate the answer.
- Each suggestion should open a new unresolved angle, next step, comparison, exception, example, or concrete detail that was not already answered directly above.
- Prefer questions that surface useful grounded material the answer did not yet explain, rather than paraphrasing the answer.
- For `guided`, stay close to the user's current intent.
- For `exploratory`, allow adjacent but still grounded directions that widen from the conversation topic, not just the last assistant sentence.
- Use only the provided contexts.

Conversation mode:
{{conversation_mode}}

User query:
{{query}}

Answer:
{{answer}}

Candidate contexts:
{{contexts_json}}
