Generate grounded follow-up suggestions for a chat answer.

Return JSON only in this exact shape:
{"suggestions":[{"text":"...", "kind":"deeper", "contextIndex":1}]}

Rules:
- Return at most {{max_suggestions}} suggestions.
- Write every suggestion in exactly the same language as the current user query.
- Ignore the language of retrieved documents, titles, labels, URLs, and the assistant answer when choosing the suggestion language.
- If the user asked in English, every suggestion must be in English.
- Make each suggestion feel like a natural next user turn, not a label, title, heading, or explanation.
- Keep each suggestion short and skimmable: prefer 4 to 8 words, and avoid going past 10 words unless clarity requires it.
- Prefer one core idea per suggestion.
- Make each suggestion understandable as a standalone question, even if shown later or outside the immediate assistant reply.
- Prefer explicit nouns over pronouns. Rewrite the topic back into the suggestion instead of using context-dependent words like "it", "they", "this", or "that".
- If a pronoun would otherwise be natural, restate the referent in the same suggestion. Example: prefer "What books did Narayani write?" over "What books did she write?"
- Prefer the most explorable grounded concept, practice, teaching, person, or term from the answer and provided contexts, not just the main named entity from the last answer.
- If the answer introduces a meaningful concept or title such as a role, teaching, practice, or lineage term, prefer at least one suggestion that explores that concept directly.
- Do not over-focus all suggestions on the same person when adjacent grounded concepts would make better next questions.
- Prefer conceptual or explanatory follow-ups over narrow biography details when both are grounded.
- Use `kind: "deeper"` when the suggestion explores the most promising grounded concept or subject more deeply.
- Use `kind: "broader"` only when the suggestion widens into a nearby grounded avenue that still fits the active conversation intent.
- Ground every suggestion in exactly one provided context and reference that context with `contextIndex`.
- Do not mention citations, source numbers, context indices, documents, pages, or titles in the suggestion text.
- Do not repeat the original query or restate the answer.
- Each suggestion should open a new unresolved angle, next step, comparison, exception, example, or concrete detail that was not already answered directly above.
- Prefer questions that surface useful grounded material the answer did not yet explain, rather than paraphrasing the answer.
- Avoid producing several suggestions that all ask for adjacent facts about the same biography, timeline, or role.
- For `guided`, stay close to the user's current intent and return only `deeper` suggestions.
- For `exploratory`, allow adjacent but still grounded directions that widen from the active conversation intent, not just the last assistant sentence.
- If the recent conversation and contexts do not honestly support a broader move, omit `broader` suggestions entirely.
- If the answer mainly states a limitation such as "I don't know", "I can't tell", or an unsupported refusal, return no suggestions unless one tightly aligned `deeper` question is clearly justified.
- Never use suggestions to recover from a weak, degraded, or off-target answer.
- Use only the provided contexts.

Conversation mode:
{{conversation_mode}}

Recent conversation context:
{{recent_turns_json}}

Active subject:
{{active_subject}}

Active goal:
{{active_goal}}

User query:
{{query}}

Answer:
{{answer}}

Candidate contexts:
{{contexts_json}}
