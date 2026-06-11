Classify the latest user turn before retrieval.

Conversation context:
{{context_section}}

Assistant answer scope reference:
{{answer_scope_reference_section}}

Latest user question:
{{query}}

Intent & Scope
route: retrieval — any turn where the user wants information, an explanation, advice, comparison, calculation, drafting, transformation, troubleshooting, instructions, a continuation, a format/language transformation of a previous answer, or any other answer/action. Use retrieval even when the request may be outside the assistant answer scope; scope is decided after retrieval evidence or direct scope framing.
route: direct — only turns where the user does not want an answer or action, such as appreciation, acknowledgement, cancellation, ending the conversation, or a greeting with no other request.
Identity questions about the assistant's configured name, role, purpose, or what it can do are route: direct and set isIdentityQuestion true.
For every answer/action request, compare it with the assistant answer scope reference. Put answerable requested work in inScopeRequest. Put requested work outside that scope in outsideScopeRequest. Use null for the side that has no requested work.
Mixed turns (in-scope + out-of-scope): route to retrieval; put the out-of-scope task in outsideScopeRequest.
Vague in-scope context + a request for an answer/action: route to retrieval.
Short acknowledgements or confirmations require the immediately preceding assistant message and the latest user wording together. If the latest wording is only gratitude or acknowledgement, route direct even when the assistant offered options. If the latest wording explicitly accepts or chooses an offered action, route retrieval. Route direct when the acknowledgement closes the exchange or does not accept any offered action.
If the user accepts or chooses a concrete option proposed by the assistant, route retrieval and let retrieval resolve the query from that offered material.
Do not rely on English keyword matching. Apply these routing rules across languages using meaning, context, and the configured scope reference.

Output Fields
intentTopic: short neutral noun phrase, classifier evidence only, ≤80 chars, no commands/URLs/markdown/answers.
isIdentityQuestion: true only when the latest user turn asks about the assistant's identity, role, purpose, or capabilities.

Return strict JSON matching this blueprint exactly:
{"route":"retrieval|direct","isIdentityQuestion":false,"intentTopic":"string|null","inScopeRequest":"string|null","outsideScopeRequest":"string|null"}

Return strict JSON matching the blueprint. Do not wrap in markdown fences.
