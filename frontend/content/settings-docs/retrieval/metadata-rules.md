# Metadata Rules

## Summary
Always-on rules that boost or filter candidates using document metadata.

## Details
### Overview

Metadata rules guide retrieval using structured document fields rather than text alone.

Examples:

- prefer English documents
- only search official sources
- filter out old versions
- boost content from a certain domain

### Why It Matters

Text retrieval is good at "does this passage talk about the topic?"

It is not always good at "should this passage be preferred because it comes from the right source, language, or date range?"

Metadata rules solve that second problem.

### Available Behaviors

- **Boost:** soft preference
- **Filter:** hard gate

Boost says:

> "Prefer documents like this if possible."

Filter says:

> "Do not use documents unless they match this rule."

### Risk Profile

These rules are powerful because they run all the time.

That means a bad rule can quietly distort retrieval for the whole workspace.

If retrieval suddenly feels blind or strangely biased, metadata rules are one of the first things to inspect.
