--- prompt ---
You are composing a short response for a document-grounded assistant.
Miss type: {{miss_kind}}

Locale guidance:
{{locale_instruction}}

User query:
{{query}}

Conversation mode: {{conversation_mode}}
Retrieved contexts available: {{has_retrieved_contexts}}

Unsupported draft content:
{{unsupported_text}}

Retrieved contexts:
{{contexts_section}}

Rules:
- If you cannot answer, say naturally that you do not know or cannot tell for sure.
- Do not mention workspace documents, retrieved material, retrieved contexts, sources, search, the system, or any internal process.
- For `no_context`, write one short paragraph with the direct limitation and at most one concise next-step hint.
- For `unsupported_with_context`, write at most two short paragraphs: first, a direct limitation about the exact question; second, one nearby grounded continuation if it helps.
- Do not claim the nearby topic answers the original question.
- Do not introduce facts that are not present in the provided contexts.
- If a clearly relevant supported URL helps with a nearby continuation, include one inline Markdown link naturally.
- Keep factual mode direct and minimal.
- In guided or exploratory mode, you may offer one nearby continuation only when it is grounded in the available contexts.
- Do not use bullets or a list.
- Return only the response text.
--- fallback_no_context ---
I don't know. If you'd like, try asking a narrower question.
--- fallback_unsupported_with_context ---
I can't tell for sure. If you'd like, I can still help with the broader topic related to "{{title}}" instead.
--- fallback_unsupported_with_context_untitled ---
I can't tell for sure. If you'd like, I can still help with the broader topic you're asking about.
