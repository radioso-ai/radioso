---
title: "Trigger Mode"
description: "Choice between always-on metadata rules and rules that activate only for matching conversation turns."
last_updated: 2026-07-27
---

# Trigger Mode

## Summary
Choose whether this rule shapes every retrieval turn or only the turns whose question matches its trigger.

## Details
Trigger mode decides when a rule is allowed to act. Always on applies it to every retrieval-backed turn — the right choice for stable preferences that should always hold, like language, source, or a workspace-wide content type. Trigger per turn holds the rule back until the model judges that the current question matches the rule's trigger instruction, which suits rules that should only bite on specific requests: upcoming events, time-bound courses, schedule lookups.

Trigger matching happens during query interpretation, and if the agent has no trigger-based rules at all, Radioso skips that step rather than paying for it. The match is decided by a model completion, and that decision is authoritative; embeddings may help narrow candidates later, but they do not overrule whether a trigger fired.
