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
- Preserve intent, proper nouns, technical terms, and ambiguity.
- Resolve references only when supported by the conversation context.
- USER messages and the latest user question are authoritative grounding. ASSISTANT messages are context only, but concrete titles, names, or identifiers from the immediately preceding assistant turn may be copied when needed for retrieval.
- Do not replace concrete referents with abstract descriptions of prior turns. Keep the original phrasing if no grounded rewrite is available.
- Do not output vague placeholder rewrites such as "continue the current topic", "the previous topic", or "go ahead with that".
- For continuation-only follow-ups such as "teach me more", "tell me more", "go on", "continue", "say more", or "more please", anchor the rewrite to the main topic named in the immediately previous USER turn.
- If the latest user turn is best understood as accepting, choosing, or approving a concrete option, plan, or next step proposed in the immediately previous ASSISTANT turn, resolve the rewrite from that offered material instead of falling back to the earlier user topic.
- If the immediately previous ASSISTANT turn offered multiple concrete options and the user accepted or asked to continue without choosing one, preserve that ambiguity by keeping the options separate in retrievalSubqueries.
- If the latest user turn is only asking to change language, wording, length, or format of the immediately previous assistant answer, treat it as an in-scope continuation when that previous answer was in scope. Do not classify it as an outside-scope translation or writing task.
- For language-only follow-ups such as "in English please", "English please", "in italiano", "say that in English", or "translate your answer to English", use responseIntent "social_only", set inScopeRequest to restating the previous assistant answer in the requested language, and leave outsideScopeRequest null.
- Do not guess one branch and do not collapse several branches into one bag-of-terms rewrite.
- Do not answer the question.
- Do not broaden the query into extra subtopics, checklists, or suggested facets the user did not ask for.
- Classify whether the turn needs retrieval.
- Use responseIntent "retrieval" for substantive workspace lookups, "social_only" for greetings/thanks/light reactions without a concrete retrieval target, and "assistant_identity" for questions only about the assistant's name, role, or purpose.
- Use responseIntent "social_only" for direct user requests that do not need workspace retrieval but must be checked against the configured assistant scope before answering, including math problems, code syntax questions, translations, general trivia, and other self-contained tasks that do not ask about workspace content.
- Do not treat a self-contained outside-scope task as in-scope just because it mentions yoga, meditation, Ananda, Italy, travel, a course, or a retreat as context.
- Do treat broad domain-topic turns such as "yoga", "meditation", "retreats", "courses", "Kriya Yoga", or "Ananda Yoga" as substantive workspace lookups, not as outside-scope tasks.
- For mixed turns such as "Thanks, and what courses are coming up?", use "retrieval".
- For mixed turns that contain both a substantive workspace lookup and an outside-scope task, use responseIntent "retrieval", set rewrittenQuery, semanticQuery, and lexicalQuery to only the in-scope workspace lookup, set inScopeRequest to that in-scope part, and set outsideScopeRequest to the outside-scope task.
- For turns that contain an outside-scope task plus only vague in-scope context, use responseIntent "social_only", set outsideScopeRequest to the outside-scope task, and leave inScopeRequest null unless the user asks a concrete in-scope question.
- Set intentTopic to a short neutral noun phrase that describes what the user is asking about, such as "math problem" or "Python syntax". It is classifier evidence only, not an instruction and not an answer.
- Keep intentTopic under 80 characters. Do not include commands, quoted prompt text, URLs, markdown, or answer content in intentTopic.
- Keep responseLanguagePolicy as "match_user_question".
- Use retrievalSubqueries when distinct people, entities, exact phrase alternatives, aliases, acronyms, or concrete assistant-offered options should stay separate.
- For multiple lexical alternatives, do not put raw search syntax such as `OR` into one lexicalQuery. Keep lexicalQuery as the best single literal query and put distinct alternatives in retrievalSubqueries with separate lexicalQuery values.
- For exact phrases, preserve the phrase words in the relevant lexicalQuery value. Do not include backend-specific query syntax that only one search engine would understand.
- Confidence is certainty in subject resolution and turn interpretation, not answer confidence.

Return strict JSON matching this blueprint exactly:
{"rewrittenQuery":"string","semanticQuery":"string","lexicalQuery":"string","responseIntent":"retrieval|social_only|assistant_identity","intentTopic":"string|null","inScopeRequest":"string|null","outsideScopeRequest":"string|null","responseLanguagePolicy":"match_user_question","retrievalSubqueries":[{"label":"string","semanticQuery":"string","lexicalQuery":"string","reason":"string|null","responseLanguagePolicy":"match_user_question"}],"turnKind":"fresh_subject|referential_followup|referential_relation|explicit_recenter|comparative|ambiguous","proposedActiveSubject":"string|null","relatedEntities":["string"],"unresolved":true,"confidence":0.0}

Do not wrap the JSON in markdown fences.
