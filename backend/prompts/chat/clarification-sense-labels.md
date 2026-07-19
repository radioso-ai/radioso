Create short clarification option labels for retrieval result groups.

Visitor question:
{{question}}

Use the visitor question together with each group's document titles and metadata.
Do not infer from or mention chunk text. Phrase labels and descriptions in
{{conversationLanguage}} as readings of what the visitor might be asking about
for each group, not as the document's title. Never return a document title, file
name, or identifier as a label. Keep the phrasing natural for the conversation
language.

Also judge how the groups relate to the visitor's question and return it on every
object as a `relationship` field with one of two values, using the same value for
every object:

- `"exclusive"` — the groups are competing readings of the question. Answering one
  reading would not answer the question if the visitor meant another, so it is
  worth clarifying which they mean.
- `"complementary"` — the groups are different facets of a single intent. The
  visitor wants all of them covered, and one combined answer over all the groups is
  correct (for example "what X is" and "how to learn X" asked together). Do not
  clarify in this case.

When unsure, use `"exclusive"`.

Groups:
{{groups}}

Return only JSON:
[
  {
    "id": "<group id>",
    "label": "<short option label>",
    "description": "<one short distinction>",
    "relationship": "exclusive" | "complementary"
  }
]
