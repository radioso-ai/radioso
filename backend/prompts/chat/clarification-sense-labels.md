Create short clarification option labels for retrieval result groups.

Visitor question:
{{question}}

Use the visitor question together with each group's document titles and metadata.
Do not infer from or mention chunk text. Phrase labels and descriptions in
{{conversationLanguage}} as readings of what the visitor might be asking about
for each group, not as the document's title. Keep the phrasing natural for the
conversation language.

Groups:
{{groups}}

Return only JSON:
[
  {
    "id": "<group id>",
    "label": "<short option label>",
    "description": "<one short distinction>"
  }
]
