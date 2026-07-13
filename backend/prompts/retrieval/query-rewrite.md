Rewrite the user's latest question for retrieval.

Conversation context:
{{context_section}}

Semantic rewrite guidance:
{{semantic_rewrite_instructions}}

Lexical rewrite guidance:
{{lexical_rewrite_instructions}}

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
Format/language-only follow-ups that ask for an answer transformation are requests; resolve them from the immediately preceding assistant answer.
Short confirmations are acceptance requests only when they explicitly accept or choose an offered next topic, action, or option; build the query/subqueries from the accepted offered material.
Self-correction turns ("wait, I meant X, not Y", "actually I'm asking about X", "no, the X side, not the Y side") replace the prior subject with X. The rewritten query, semanticQuery, lexicalQuery, proposedActiveSubject, and retrievalSubqueries must contain only X. Do not carry Y, Y's modifiers, or Y-specific terms forward — even when prior turns established Y.

Queries
Do not broaden into extra subtopics the user didn't ask for.
Do not include backend-specific query syntax.
Use retrievalSubqueries when distinct entities, aliases, acronyms, or concrete options should stay separate.
semanticQuery should capture answer intent and retrieval meaning.
lexicalQuery should preserve exact surface forms that are likely to appear in source text.
When you resolve a concrete proposedActiveSubject, make the relevant lexicalQuery the subject itself, not the surrounding request/action wording.
For exact phrases, preserve the phrase words in the relevant lexicalQuery value.

queryShape: use enum values only; use "general_grounding" when no specialized shape is clear.
temporalQueryMode: use "listing" only for an anchorless event/date query that asks for a list or ordering of dated events without naming a specific topic; use "topic_refinement" for a named event/topic temporal question; otherwise use "none". This is your structured judgment and must not rely on backend keyword rules.
confidence: certainty in subject resolution and turn interpretation, not answer confidence.

Return strict JSON matching this blueprint exactly:
{"rewrittenQuery":"string","semanticQuery":"string","lexicalQuery":"string","queryShape":"definition_lookup|event_date_lookup|policy_answer|exploratory_summary|follow_up_grounding|default_hybrid|general_grounding","temporalQueryMode":"none|listing|topic_refinement","retrievalSubqueries":[{"label":"string","semanticQuery":"string","lexicalQuery":"string","reason":"string|null"}],"turnKind":"fresh_subject|referential_followup|referential_relation|explicit_recenter|comparative|ambiguous","proposedActiveSubject":"string|null","relatedEntities":["string"],"unresolved":false,"confidence":0.95}

Return strict JSON matching the blueprint. Do not wrap in markdown fences.
