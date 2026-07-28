---
title: "Metadata Rule Value Type"
description: "Metadata rule setting specifying whether values are text, number, date, or boolean to determine valid comparison operators."
last_updated: 2026-07-27
---

# Value Type

## Summary
Tell the rule whether its value is text, a number, a date, or a boolean.

## Details
The value type tells the rule engine how to read both the field and your value — as plain text, a number, a calendar date, or a true/false flag. That choice drives everything downstream: it decides which operators are offered and how the comparison is carried out. A date type compares chronologically and unlocks threshold operators like `gte` and the `today()` token; text compares as strings; a number compares by magnitude rather than character by character.

Set this to match how the field is really stored. Typing a date field as text, for example, would compare `2025-01-02` and `2025-1-2` as unequal strings and quietly break a range rule.
