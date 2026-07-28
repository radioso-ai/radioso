---
title: "Trigger Instruction"
description: "Operator-facing description of the question pattern that should activate a trigger-based metadata rule."
last_updated: 2026-07-27
---

# Trigger Instruction

## Summary
Describe, in plain terms, the kind of question that should switch on a trigger-based rule.

## Details
This is the description the model reads to decide whether the current turn matches, so write it as a plain statement of the question pattern rather than a retrieval implementation note. Aim for concrete and specific:

- Enact when the user is clearly asking about upcoming events or conferences.
- Enact when the user wants active courses, camps, or currently open registrations.
- Enact when the user asks for policies that apply today rather than archived versions.

A vague instruction is the usual cause of a rule that fires too often or not often enough, so tighten the wording when a trigger feels either trigger-happy or asleep. Keeping it short and specific also makes it easier to debug: the same text appears in the retrieval diagnostics, so you can see exactly what the model was judging against.
