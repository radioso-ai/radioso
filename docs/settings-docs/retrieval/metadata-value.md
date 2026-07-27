---
title: "Metadata Rule Value"
description: "Reference for entering the comparison value a metadata filter rule should test against."
last_updated: 2026-07-27
---

# Value

## Summary
The value the rule tests the metadata field against, like `en`, `official`, or `2025-01-01`.

## Details
This is what the operator compares the field to — `en` for a language rule, `true` for a boolean flag, `2025-01-01` for a date threshold, `official` for a source tag. Match its form to the value type: a date rule wants an ISO date, a boolean wants `true` or `false`.

Most metadata rules that misbehave fail right here. The key and operator are fine, but the value does not match what the documents actually store — `EN` versus `en`, a full URL versus a bare domain, a display name versus a slug. When a rule is not matching what you expect, check the value against a real document's metadata first.
