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
Format/language-only follow-ups → responseIntent: social_only; inScopeRequest = restate previous answer in requested language; outsideScopeRequest: null.

Intent & Scope
responseIntent: retrieval — substantive lookups, including procedural support ("how do I…", "can I…", "where can I…")
social_only — greetings, thanks, self-contained tasks (math, code, translation, trivia) not requiring workspace retrieval
assistant_identity — questions about the assistant's name, role, or purpose
Mixed turns (in-scope + out-of-scope): use retrieval; put the out-of-scope task in outsideScopeRequest.
Vague in-scope context + out-of-scope task: use social_only; inScopeRequest: null unless a concrete in-scope question exists.

Queries
Do not broaden into extra subtopics the user didn't ask for.
Do not include backend-specific query syntax.
Use retrievalSubqueries when distinct entities, aliases, acronyms, or concrete options should stay separate.
For exact phrases, preserve the phrase words in the relevant lexicalQuery value.

Output Fields
intentTopic: short neutral noun phrase, classifier evidence only, ≤80 chars, no commands/URLs/markdown/answers.
responseLanguage: prefer latest user question language; fall back to most recent clear preference; use concise label (e.g. "English", "Spanish").
responseLanguagePolicy: always "match_user_question".
queryShape: use enum values only; use "general_grounding" when no specialized shape is clear.
confidence: certainty in subject resolution and turn interpretation, not answer confidence.

Return strict JSON matching this blueprint exactly:
{"rewrittenQuery":"string","semanticQuery":"string","lexicalQuery":"string","responseIntent":"retrieval|social_only|assistant_identity","intentTopic":"string|null","inScopeRequest":"string|null","outsideScopeRequest":"string|null","responseLanguagePolicy":"match_user_question","responseLanguage":"string","queryShape":"definition_lookup|event_date_lookup|policy_answer|exploratory_summary|follow_up_grounding|default_hybrid|general_grounding","retrievalSubqueries":[{"label":"string","semanticQuery":"string","lexicalQuery":"string","reason":"string|null","responseLanguagePolicy":"match_user_question"}],"turnKind":"fresh_subject|referential_followup|referential_relation|explicit_recenter|comparative|ambiguous","proposedActiveSubject":"string|null","relatedEntities":["string"],"unresolved":true,"confidence":0.0}

Return strict JSON matching the blueprint. Do not wrap in markdown fences.
