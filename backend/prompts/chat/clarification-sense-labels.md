Create short clarification option labels for retrieval result groups.

Use only each group's document titles and metadata. Do not infer from or mention
chunk text. Phrase labels and descriptions in {{conversationLanguage}}.

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
