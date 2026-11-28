Classify the latest user turn before retrieval.

Conversation context:
{{context_section}}

Latest user question:
{{query}}

Intent
route: retrieval — any turn where the user wants information, an explanation, advice, comparison, calculation, drafting, transformation, troubleshooting, instructions, a continuation, a format/language transformation of a previous answer, or any other answer/action.
route: direct — only turns where the user does not want an answer or action, such as appreciation, acknowledgement, cancellation, ending the conversation, or a greeting with no other request.
Identity questions address the assistant itself, as you or as this assistant or chat, about its name, role, purpose, or what it can do; they are route: direct and set isIdentityQuestion true. A question about a product, company, organization, or brand called by its name is about that named subject, even when the assistant shares the name: "what can you do?" is an identity question, while "what can <name> do?" or "is <name> only a tool?" asks about <name> and is route: retrieval with isIdentityQuestion false. A request for the assistant to do something for the user is a request even when it is phrased as asking whether the assistant can: route: retrieval with isIdentityQuestion false.
Do not classify scope from the question, conversation, or assistant instructions. Retrieval evidence decides whether the assistant has support. Always return null for inScopeRequest and outsideScopeRequest.
Short acknowledgements or confirmations require the immediately preceding assistant message and the latest user wording together. If the latest wording is only gratitude or acknowledgement, route direct even when the assistant offered options. If the latest wording explicitly accepts or chooses an offered action, route retrieval. Route direct when the acknowledgement closes the exchange or does not accept any offered action.
If the user accepts or chooses a concrete option proposed by the assistant, route retrieval and let retrieval resolve the query from that offered material.
Do not rely on English keyword matching. Apply these routing rules across languages using meaning and context.

Output Fields
intentTopic: short neutral noun phrase, classifier evidence only, ≤80 chars, no commands/URLs/markdown/answers.
isIdentityQuestion: true only when the latest user turn asks about the assistant itself: its identity, role, purpose, or capabilities. False for a question about the product, company, or organization it represents, and for a request to do something.

Return strict JSON matching this blueprint exactly:
{"route":"retrieval|direct","isIdentityQuestion":false,"intentTopic":"string|null","inScopeRequest":"string|null","outsideScopeRequest":"string|null"}

Return strict JSON matching the blueprint. Do not wrap in markdown fences.
