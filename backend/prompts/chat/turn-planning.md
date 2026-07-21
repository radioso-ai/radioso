Plan the assistant's next turn in a single pass. You decide, together and consistently, four things about the latest user turn: how to route it, how to rewrite it for retrieval, which language to answer in, which registered routines it wants to start, and which behavioral directives apply.

Conversation context:
{{context_section}}

{{conversation_summary_section}}

Assistant answer scope reference:
{{answer_scope_reference_section}}

Semantic rewrite guidance:
{{semantic_rewrite_instructions}}

Lexical rewrite guidance:
{{lexical_rewrite_instructions}}

Candidate routines the user might be trying to start:
{{routine_candidates_section}}

Candidate behavioral directives and the condition under which each applies:
{{directive_candidates_section}}

Latest user question:
{{query}}

Routing Rules
route: retrieval - any turn where the user wants information, an explanation, advice, comparison, calculation, drafting, transformation, troubleshooting, instructions, a continuation, a format/language transformation of a previous answer, or any other answer/action. Use retrieval even when the request may be outside the assistant answer scope; scope is decided after retrieval evidence or direct scope framing.
route: direct - only turns where the user does not want an answer or action, such as appreciation, acknowledgement, cancellation, ending the conversation, or a greeting with no other request.
Identity questions about the assistant's configured name, role, purpose, or what it can do are route: direct and set isIdentityQuestion true.
For every answer/action request, compare it with the assistant answer scope reference. Put answerable requested work in inScopeRequest. Put requested work outside that scope in outsideScopeRequest. Use null for the side that has no requested work.
Mixed turns (in-scope + out-of-scope): route to retrieval; put the out-of-scope task in outsideScopeRequest.
Vague in-scope context + a request for an answer/action: route to retrieval.
Short acknowledgements or confirmations require the immediately preceding assistant message and the latest user wording together. If the latest wording is only gratitude or acknowledgement, route direct even when the assistant offered options. If the latest wording explicitly accepts or chooses an offered action, route retrieval. Route direct when the acknowledgement closes the exchange or does not accept any offered action.
If the user accepts or chooses a concrete option proposed by the assistant, route retrieval and let retrieval resolve the query from that offered material.
Do not rely on English keyword matching. Apply these routing rules across languages using meaning, context, and the configured scope reference.

Retrieval Rewrite Rules
If route is direct, set rewrite to null.
If route is retrieval, provide rewrite fields exactly as instructed below.
Grounding: preserve intent, proper nouns, technical terms, and ambiguity.
USER messages are authoritative. ASSISTANT messages are context only; concrete titles, names, or identifiers from the immediately preceding assistant turn may be copied when needed.
Resolve references only when supported by conversation context. Do not replace concrete referents with abstract descriptions of prior turns.
Never output vague placeholders ("continue the current topic", "the previous topic", "go ahead with that").
Continuation-only follow-ups ("tell me more", "go on", "continue") -> anchor to the main topic of the immediately preceding USER turn.
If the user accepts or chooses a concrete option proposed by the assistant, resolve the rewrite from that offered material.
If the user accepts without choosing among multiple offered options, keep options separate in retrievalSubqueries.
Do not guess one branch and do not collapse several branches into one bag-of-terms rewrite.
Format/language-only follow-ups that ask for an answer transformation are requests; resolve them from the immediately preceding assistant answer.
Short confirmations are acceptance requests only when they explicitly accept or choose an offered next topic, action, or option; build the query/subqueries from the accepted offered material.
Self-correction turns ("wait, I meant X, not Y", "actually I'm asking about X", "no, the X side, not the Y side") replace the prior subject with X. The rewritten query, semanticQuery, lexicalQuery, proposedActiveSubject, and retrievalSubqueries must contain only X. Do not carry Y, Y's modifiers, or Y-specific terms forward - even when prior turns established Y.
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

Response Language Rules
Decide the language the assistant should answer in for this turn.
If the user has explicitly instructed the assistant to answer in a specific language, that instruction is sticky across later turns until the user explicitly changes it.
If there is no explicit language instruction, use the language of the latest user question.
If the latest user message is short, neutral, or language-ambiguous, preserve the most recent explicit language instruction from the conversation when one exists.
Return a concise human-readable language label such as "English", "Spanish", or "Estonian".
If there is no user message or no reliable language can be determined, use null.

Routine Ranking Rules
Consider only the candidate routines listed above. Return one confidence score for every candidate routine that could plausibly match the latest user message.
routineId: exactly one listed candidate routine id. Never invent an id.
confidence: number from 0 to 1 for how likely the latest user message is asking to start that routine.
variables: optional object of values the user supplied in the latest user message for that routine. Extract only values clearly stated or unambiguously implied by the latest user message. Use the routine's own field names when they are clear from the candidate description; otherwise omit variables. Never copy values from earlier turns and never invent values.
Do not ask the user a question. Do not choose by priority yourself; priority is authored metadata for downstream arbitration only.
If no candidate routine plausibly matches, return an empty routineRankings array.

Directive Rules
Consider only the candidate directives listed above. Each has a name and a condition describing when it applies.
Decide which directives' conditions hold for this turn. A condition may be written in any language and the turn may be in any language; judge by meaning, not by matching words.
For every candidate directive, return one object with its name, matched (true when the condition holds this turn, false otherwise), and confidence (0 to 1 for how strongly the condition holds).
Use only the directive names provided. Do not invent names. Judge whether each directive applies, not what it instructs.

Return strict JSON matching this blueprint exactly:
{"route":"retrieval|direct","isIdentityQuestion":false,"intentTopic":"string|null","inScopeRequest":"string|null","outsideScopeRequest":"string|null","rewrite":{"rewrittenQuery":"string","semanticQuery":"string","lexicalQuery":"string","queryShape":"definition_lookup|event_date_lookup|policy_answer|exploratory_summary|follow_up_grounding|default_hybrid|general_grounding","temporalQueryMode":"none|listing|topic_refinement","retrievalSubqueries":[{"label":"string","semanticQuery":"string","lexicalQuery":"string","reason":"string|null"}],"turnKind":"fresh_subject|referential_followup|referential_relation|explicit_recenter|comparative|ambiguous","proposedActiveSubject":"string|null","relatedEntities":["string"],"unresolved":false,"confidence":0.95},"responseLanguage":"string|null","routineRankings":[{"routineId":"string","confidence":0.0,"variables":{"field":"value"}}],"directiveClassifications":[{"name":"string","matched":false,"confidence":0.0}]}

Return strict JSON matching the blueprint. Do not wrap in markdown fences.
