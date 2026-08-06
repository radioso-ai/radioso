Create short clarification option labels for retrieval result groups.

Visitor question:
{{question}}

Use the visitor question together with each group's document titles and metadata.
Phrase labels and descriptions in {{conversationLanguage}} as readings of what the
visitor might be asking about for each group, not as the document's title. Never
return a document title, file name, or identifier as a label. Keep the phrasing
natural for the conversation language.

Each group also carries short `excerpts` of its own content. Use the excerpts only
to judge the `relationship` field below — in particular, whether two groups state
the same content in different words. Never quote or mention excerpt text, and
never derive a label or description from it.

Also judge how the groups relate to the visitor's question and return it on every
object as a `relationship` field with one of three values, using the value that
fits each group (a set can legitimately mix `"complementary"` and `"redundant"`
groups):

- `"exclusive"` — the groups are competing readings of the question. Answering one
  reading would not answer the question if the visitor meant another, so it is
  worth clarifying which they mean.
- `"complementary"` — the groups are different facets of a single intent. The
  visitor wants all of them covered, and one combined answer over all the groups is
  correct (for example "what X is" and "how to learn X" asked together). Do not
  clarify in this case.
- `"redundant"` — the groups are near-duplicate or versioned copies of the same
  content, such as a published page and a draft or updated copy of it. The
  decisive signal is the excerpts restating the same material, even when reworded,
  reordered, or partly rewritten. Titles that differ only by a version, draft, or
  status marker, and slugs or URLs in the metadata that differ only by such a
  marker, corroborate it. Answering from all of them is correct, and clarifying
  which one is pointless. Use this only when the groups cover the same subject, not
  merely a similar topic — groups that share only boilerplate such as a footer,
  contact block, or pricing notice are not redundant.

When unsure, use `"exclusive"`.

Groups:
{{groups}}

Return only JSON:
[
  {
    "id": "<group id>",
    "label": "<short option label>",
    "description": "<one short distinction>",
    "relationship": "exclusive" | "complementary" | "redundant"
  }
]
