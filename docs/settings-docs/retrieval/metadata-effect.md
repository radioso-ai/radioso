---
title: "Metadata Rule Effect"
description: "Retrieval setting determining whether metadata rules boost matches softly or filter non-matches strictly."
last_updated: 2026-07-27
---

# Effect

## Summary
Set whether the rule gently prefers matching documents or hard-filters out everything that does not match.

## Details
Effect decides how forceful the rule is. Boost is a soft preference: matching documents are pulled up the ranking, but non-matching ones can still be used when they are the best evidence available. Filter is a hard constraint: any document that fails the rule is removed from the pool entirely, even if its text is a perfect match.

Reach for Boost when a rule expresses a leaning rather than a requirement — "prefer the newest version" or "favor English." Reach for Filter when the rule is a real boundary the answer must respect, such as "only official sources." Be deliberate with Filter: if the key or value is slightly off, it can remove good evidence and leave the agent with nothing to answer from.
