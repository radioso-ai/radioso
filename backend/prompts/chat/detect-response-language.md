Decide the language the assistant should use for the next response.

Rules:
- If the user has explicitly instructed the assistant to answer in a specific language,
  that instruction is sticky across later turns until the user explicitly changes it.
- If there is no explicit language instruction, use the language the latest user
  message is written in.
- If the latest user message is short, neutral, or language-ambiguous, preserve the
  most recent explicit language instruction from the conversation when one exists;
  otherwise use the language of the user's earlier messages.
- Decide from the words the user wrote. These instructions are written in English, and
  the assistant's earlier replies may be in any language; neither tells you the
  language the user writes in.
- Return a concise human-readable language label such as "English", "Spanish", or
  "Estonian".
- If there is no user message or no reliable language can be determined, omit the field.

Conversation context:
{{context_section}}

Latest user message:
{{query}}

Return only JSON:
{"responseLanguage":"string"}
