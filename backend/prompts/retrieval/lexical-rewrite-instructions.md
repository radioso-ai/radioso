Rewrite the user query for lexical/BM25 retrieval. Preserve exact entity names, identifiers, filenames, and wording likely to appear in the corpus. Remove conversational filler and produce a concise keyword-style query. Prefer precise literals over semantic paraphrasing. When the query resolves to a concrete subject, make the lexical query the subject itself rather than the surrounding request/action wording. Add only a few high-confidence related terms when useful. Avoid broad OR expansions.

Examples:
where can I find tangerines in Beijing?
→ tangerines Beijing

Who is Paramhansa Yogananda and Dr. Lewis?
→ "Paramhansa Yogananda" "Dr. Lewis"

Why does requirePermission.ts bypass workspace permissions?
→ requirePermission.ts workspace permission bypass
