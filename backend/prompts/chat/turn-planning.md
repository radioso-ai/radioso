Plan the assistant's next turn in a single pass. Produce independent decisions about how to route it, how to rewrite it for retrieval, and which language to answer in.

Conversation context:
{{context_section}}

{{conversation_summary_section}}

Semantic rewrite guidance:
{{semantic_rewrite_instructions}}

Lexical rewrite guidance:
{{lexical_rewrite_instructions}}

Latest user question:
{{query}}{{decision_independence_section}}

Routing Rules
route: retrieval - any turn where the user wants information, an explanation, advice, comparison, calculation, drafting, transformation, troubleshooting, instructions, a continuation, a format/language transformation of a previous answer, or any other answer/action.
route: direct - only turns where the user does not want an answer or action, such as appreciation, acknowledgement, cancellation, ending the conversation, or a greeting with no other request.
Identity questions about the assistant's configured name, role, purpose, or what it can do are route: direct and set isIdentityQuestion true.
Do not classify scope from the question, conversation, or assistant instructions. Retrieval evidence decides whether the assistant has support. Always return null for inScopeRequest and outsideScopeRequest.
Short acknowledgements or confirmations require the immediately preceding assistant message and the latest user wording together. If the latest wording is only gratitude or acknowledgement, route direct even when the assistant offered options. If the latest wording explicitly accepts or chooses an offered action, route retrieval. Route direct when the acknowledgement closes the exchange or does not accept any offered action.
If the user accepts or chooses a concrete option proposed by the assistant, route retrieval and let retrieval resolve the query from that offered material.
Do not rely on English keyword matching. Apply these routing rules across languages using meaning and context.

Interaction Role Rules
Classify the latest user turn independently of route using exactly one interactionRole:
- substantive_new: a new information need or requested action that stands on its own.
- substantive_followup: a substantive information need or requested action whose subject or meaning depends on conversation context. Its retrieval rewrite must still be self-contained.
- clarification_value: the latest message only supplies a value requested by a pending clarification; it does not introduce another information need.
- control: the latest message only confirms, cancels, selects, advances, or supplies a value to an existing action, menu, decision, or routine.
- social: the latest message is only conversational, including a greeting, thanks, acknowledgement, farewell, or assistant-identity exchange, with no substantive information need.
- unresolved: available context is insufficient to tell whether the latest message contains a substantive information need or what that need is.
A short reply can be substantive_followup when it asks for more information. A choice or acceptance that only controls an offered action is control even when routing must execute that action. Apply these meanings across languages; never infer the role with keyword matching.

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
If the immediately preceding assistant message lists concrete options in order and the user selects one by ordinal or relative position, resolve the reference to the corresponding concrete option from that list. Copy that option's name into rewrittenQuery, semanticQuery, lexicalQuery, and proposedActiveSubject. Do not retain an ordinal placeholder such as first option or second plan after resolving it.
Do not guess one branch and do not collapse several branches into one bag-of-terms rewrite.
Format/language-only follow-ups that ask for an answer transformation are requests; resolve them from the immediately preceding assistant answer.
Short confirmations are acceptance requests only when they explicitly accept or choose an offered next topic, action, or option; build the query/subqueries from the accepted offered material.
Self-correction turns ("wait, I meant X, not Y", "actually I'm asking about X", "no, the X side, not the Y side") replace the prior subject with X. The rewritten query, semanticQuery, lexicalQuery, proposedActiveSubject, and retrievalSubqueries must contain only X. Do not carry Y, Y's modifiers, or Y-specific terms forward - even when prior turns established Y.
Do not broaden into extra subtopics the user didn't ask for.
Do not include backend-specific query syntax.
Use retrievalSubqueries when distinct entities, aliases, acronyms, or concrete options should stay separate.
semanticQuery must be a concise, self-contained retrieval formulation, not conversational wording. Express the concrete subject plus the requested fact, attribute, relation, or procedure; do not merely copy a question when it can be normalized without losing meaning.
lexicalQuery should preserve the exact named subject, phrase, identifier, or surface form most likely to appear in source text. Do not pad it with conversational request wording.
When you resolve a concrete proposedActiveSubject, make the relevant lexicalQuery the subject itself, not the surrounding request/action wording.
For exact phrases, preserve the phrase words in the relevant lexicalQuery value.
queryShape: use the semantic definitions below. Apply them by meaning in every language, not by matching words.
- definition_lookup: identification or one discrete fact or attribute about a named entity, term, acronym, product, plan, or concept, including its meaning, price, or included feature.
- event_date_lookup: the date, time, schedule, or ordering of an event.
- policy_answer: a procedural, compliance, eligibility, or support-policy question.
- exploratory_summary: a broad overview, synthesis, or comparison across material.
- follow_up_grounding: a follow-up whose subject must be resolved from conversation context and that does not fit a more specific shape.
- general_grounding: a grounded answer that does not fit a specialized shape. Use default_hybrid only when the default retrieval strategy itself is the intended shape.
Do not use policy_answer merely because the assistant has a behavioral directive about the topic. Classify the user's requested answer, not the instructions for how to answer it.
After resolving a follow-up to a concrete subject, use the specialized shape that fits the resolved request. For example, a follow-up asking for one discrete attribute remains definition_lookup; use follow_up_grounding only when no specialized shape applies.
temporalQueryMode: use "listing" only for an anchorless event/date query that asks for a list or ordering of dated events without naming a specific topic; use "topic_refinement" for a named event/topic temporal question; otherwise use "none". This is your structured judgment and must not rely on backend keyword rules.
confidence: certainty in subject resolution and turn interpretation, not answer confidence.

Response Language Rules
Decide the language the assistant should answer in for this turn.
If the user has explicitly instructed the assistant to answer in a specific language, that instruction is sticky across later turns until the user explicitly changes it.
If there is no explicit language instruction, use the language of the latest user question.
If the latest user message is short, neutral, or language-ambiguous, preserve the most recent explicit language instruction from the conversation when one exists.
Return a concise human-readable language label such as "English", "Spanish", or "Estonian".
If there is no user message or no reliable language can be determined, use null.{{page_read_section}}{{routine_section}}{{directive_section}}{{output_shape_section}}

The provider response schema, when available, fixes the field set and value sets. The output-shape rules remain the fallback contract for providers that cannot enforce that schema.
