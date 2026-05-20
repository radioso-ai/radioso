Rewrite the user's latest question for retrieval.

Conversation context:
{{context_section}}

Semantic rewrite guidance:
{{semantic_rewrite_instructions}}

Lexical rewrite guidance:
{{lexical_rewrite_instructions}}

{{answer_scope_reference_section}}

Latest user question:
{{query}}

Rules:
Grounding

Preserve intent, proper nouns, technical terms, and ambiguity.
USER messages are authoritative. ASSISTANT messages are context only; concrete titles, names, or identifiers from the immediately preceding assistant turn may be copied when needed.
Resolve references only when supported by conversation context. Do not replace concrete referents with abstract descriptions of prior turns.

Rewrites
Never output vague placeholders ("continue the current topic", "the previous topic", "go ahead with that").
Continuation-only follow-ups ("tell me more", "go on", "continue") → anchor to the main topic of the immediately preceding USER turn.
If the user accepts or chooses a concrete option proposed by the assistant, resolve the rewrite from that offered material.
If the user accepts without choosing among multiple offered options, keep options separate in retrievalSubqueries.
Do not guess one branch and do not collapse several branches into one bag-of-terms rewrite.
Format/language-only follow-ups that ask for an answer transformation are requests; resolve them from the immediately preceding assistant answer and use responseIntent: retrieval.
Short confirmations after an assistant message with an offered next topic, action, question, or list of options are acceptance requests. Use responseIntent: retrieval and build the query/subqueries from the offered material.
Self-correction turns ("wait, I meant X, not Y", "actually I'm asking about X", "no, the X side, not the Y side") replace the prior subject with X. The rewritten query, semanticQuery, lexicalQuery, proposedActiveSubject, and retrievalSubqueries must contain only X. Do not carry Y, Y's modifiers, or Y-specific terms forward — even when prior turns established Y.

Intent & Scope
responseIntent: retrieval — any turn where the user wants information, an explanation, advice, comparison, calculation, drafting, transformation, troubleshooting, instructions, a continuation, or any other answer/action. Use retrieval even when the request may be outside the assistant answer scope; scope is decided after retrieval evidence.
social_only — only turns where the user does not want an answer or action, such as appreciation, acknowledgement, cancellation, or ending the conversation.
assistant_identity — questions about the assistant's name, role, or purpose
For every answer/action request, compare it with the assistant answer scope reference. Put answerable requested work in inScopeRequest. Put requested work outside that scope in outsideScopeRequest. Use null for the side that has no requested work.
Mixed turns (in-scope + out-of-scope): use retrieval; put the out-of-scope task in outsideScopeRequest.
Vague in-scope context + a request for an answer/action: use retrieval.
For short acknowledgements or confirmations, inspect the immediately preceding assistant message. If it offered any next topic, action, continuation, question, or option list, treat the user message as accepting that offer and use retrieval. Use social_only only when the acknowledgement closes the exchange or does not accept any offered action.

Queries
Do not broaden into extra subtopics the user didn't ask for.
Do not include backend-specific query syntax.
Use retrievalSubqueries when distinct entities, aliases, acronyms, or concrete options should stay separate.
For exact phrases, preserve the phrase words in the relevant lexicalQuery value.

Output Fields
intentTopic: short neutral noun phrase, classifier evidence only, ≤80 chars, no commands/URLs/markdown/answers.
responseLanguage: an explicit user instruction in conversation context to use a specific language ("answer in Spanish from now on", "switch to French", "vasta eesti keeles") is sticky — continue using that language on every subsequent turn until the user explicitly instructs a different language. Do not switch languages just because the latest user turn was written in a different language than the requested one; the instruction wins. Absent any explicit instruction, prefer the language of the latest user question. Use a concise label (e.g. "English", "Spanish", "Estonian").
responseLanguagePolicy: always "match_user_question".
queryShape: use enum values only; use "general_grounding" when no specialized shape is clear.
confidence: certainty in subject resolution and turn interpretation, not answer confidence.

Return strict JSON matching this blueprint exactly:
{"rewrittenQuery":"string","semanticQuery":"string","lexicalQuery":"string","responseIntent":"retrieval|social_only|assistant_identity","intentTopic":"string|null","inScopeRequest":"string|null","outsideScopeRequest":"string|null","responseLanguagePolicy":"match_user_question","responseLanguage":"string","queryShape":"definition_lookup|event_date_lookup|policy_answer|exploratory_summary|follow_up_grounding|default_hybrid|general_grounding","retrievalSubqueries":[{"label":"string","semanticQuery":"string","lexicalQuery":"string","reason":"string|null","responseLanguagePolicy":"match_user_question"}],"turnKind":"fresh_subject|referential_followup|referential_relation|explicit_recenter|comparative|ambiguous","proposedActiveSubject":"string|null","relatedEntities":["string"],"unresolved":true,"confidence":0.0}

Return strict JSON matching the blueprint. Do not wrap in markdown fences.
