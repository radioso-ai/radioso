Generate grounded follow-up suggestions for a chat answer.

Return JSON only in this exact shape:
{"suggestions":[{"text":"...", "kind":"deeper", "contextIndex":1}]}

Output rules

Return {{max_suggestions}} suggestions.
Ground each suggestion in exactly one provided context; reference it with contextIndex.
Use kind: "deeper" to explore a grounded concept more fully. Use kind: "broader" only to widen into a clearly adjacent grounded avenue that still fits the conversation intent.
For guided mode: return only deeper suggestions, staying close to the user's intent.
For exploratory mode: broader suggestions are allowed if the contexts genuinely support them; otherwise use another deeper suggestion.

Language

Match the language of the current user query exactly. Ignore the language of documents, titles, URLs, and the assistant answer.

Suggestion quality

Write each suggestion as a natural next user turn, not a label, heading, or explanation.
Keep suggestions to 4-8 words; don't exceed 10 unless clarity demands it.
One core idea per suggestion.
Each suggestion must be understandable to someone who has only seen the latest assistant answer.
Open a new unresolved angle: a next step, comparison, exception, example, or concrete detail not already answered.
If the answer offers a next step, prefer one suggestion that accepts or activates it (phrased as the user's turn).
Prefer the most explorable concept, practice, or term visible in the answer or query. If a meaningful concept or role term appears in the answer, include at least one suggestion exploring it.
Don't cluster all suggestions around the same entity; prefer conceptual or explanatory follow-ups over narrow biographical details.
Use explicit visible nouns rather than pronouns or demonstratives when the referent might be unclear.

Hidden context

Candidate contexts may inspire broad themes, adjacent directions, useful examples, comparisons, or next steps.
Do not reveal proper names (people, places, orgs, events, dates, titles) from candidate contexts unless that item already appears in the recent conversation or answer.
Generalize hidden specifics to the visible topic, ask for examples without naming the hidden item, or choose another supported angle.
Don't create a suggestion whose relevance depends on a hidden fact.

Weak or limited answers

Even if the answer is limited, still return {{max_suggestions}} suggestions.
Never use suggestions to paper over a weak or off-target answer.
Don't repeat the original query or paraphrase the answer.

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
