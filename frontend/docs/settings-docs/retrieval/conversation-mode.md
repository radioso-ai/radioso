# Conversation Mode

## Summary
Choose how broadly the assistant responds in customer-facing chat.

## Details
### Overview

Conversation mode is an assistant behavior setting. It controls how much the assistant expands after answering the current question.

It does not relax grounding. When the assistant uses retrieval, answers are still generated from retrieved evidence and shown with citation metadata when available.

### Factual

Use this when you want the assistant to answer the current question and stop.

Factual mode keeps responses direct and avoids proactively suggesting adjacent topics. If retrieval finds two close senses with no clear winner, the default clarification policy still answers the strongest sense first and may offer the alternative inline.

### Guided

Use this when you want the assistant to answer directly and then occasionally point to one or two nearby grounded directions.

Guided mode is the default because it adds a small amount of discovery without turning every answer into an exploration flow.

### Exploratory

Use this when discovery matters as much as the direct answer.

Exploratory mode answers the question, then uses the recent conversation to decide which grounded next steps are actually useful.

When the workspace has honest support for it, the assistant can show two kinds of suggested questions:

- deeper suggestions stay on the current subject and keep drilling into the same goal
- broader suggestions widen to nearby grounded territory that still matches the conversation intent

If the available material only supports one of those lanes, the assistant shows only that lane. It does not invent broader discovery prompts just to fill space.

### Suggestion Count

When suggested questions are enabled, the assistant asks the suggestion generator for the configured number of follow-up questions. Final display can still show fewer if returned suggestions cannot be tied back to a retrieved context.
