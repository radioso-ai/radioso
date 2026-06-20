---
title: "Query Rewrite"
description: "How query rewrite converts conversational user messages into optimized semantic and lexical search queries for better recall."
last_updated: 2026-06-09
---

# Query Rewrite

## Summary
Rewrite the user request into optimized semantic and lexical search queries.

## Details
### Overview

Query rewrite converts the user request into retrieval-oriented semantic and lexical queries before search begins.

### Why It Exists

Users often ask things like:

- "what about the exception?"
- "does that also apply to contractors?"
- "show me the policy for this"

Those may make sense in conversation, but they are weak search queries on their own.

Rewrite turns them into something more like:

> "What is the exception described in the employee reimbursement policy, and does it also apply to contractors?"

That gives retrieval a much better chance of finding the right evidence.

### What Changes

- The user message is not always used raw for search.
- The system may produce a standalone semantic query.
- It may also produce a more exact lexical query.
- Retrieval then uses those rewritten forms instead of relying only on the original wording.

### Main Benefit

The biggest win is **better recall**.

Rewrite helps when:

- the user is asking a follow-up
- the message is short or vague
- the important subject is implied by earlier chat history
- the wording is conversational but the corpus is formal

### Main Risk

The danger is **over-interpretation**.

If the rewrite is too aggressive, the system can search for what it *thinks* the user meant instead of what the user actually asked.

That is why rewrite quality matters: it should add missing context, not invent a new question.

### Usage Guidance

Enable this when queries are conversational, incomplete, or heavily dependent on chat context.

Be more careful if:

- exact legal or technical wording matters a lot
- the user’s phrasing must be preserved very closely
- the system has a history of drifting subjects during follow-up questions
