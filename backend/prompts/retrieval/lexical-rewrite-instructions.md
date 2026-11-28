Rewrite the user query for lexical/BM25 retrieval. Preserve exact entity names, identifiers, filenames, and wording likely to appear in the corpus. Remove conversational filler and produce a concise keyword-style query. Prefer precise literals over semantic paraphrasing. When the query resolves to a concrete subject, make the lexical query the subject itself rather than the surrounding request/action wording. Add only a few high-confidence related terms when useful. Avoid broad OR expansions.

Named item: when the question names a single item together with a word for its kind (a plan, a course, or a room called by its name, in any language), the lexical query is always that phrase, then OR, then the item's name alone, as in `Rome retreat OR Rome`. This holds when that phrase is the resolved subject too: the subject stays first and its bare name follows. A page often heads the item's own section with its bare name and never repeats the kind word there, so the name alone runs as its own search. Add the bare name only, never synonyms, translations, or other variants.

Examples:
where can I find tangerines in Beijing?
→ tangerines Beijing

Who is Swami Orin and Dr. Hale?
→ "Swami Orin" "Dr. Hale"

Why does requirePermission.ts bypass workspace permissions?
→ requirePermission.ts workspace permission bypass

How much is the Aurora suite per night?
→ Aurora suite OR Aurora

¿Cuánto cuesta la habitación Olivo?
→ habitación Olivo OR Olivo
