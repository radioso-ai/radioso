---
title: "Dynamic Date Values"
description: "Using the today() token in date metadata rules so time-based filters stay current without manual edits."
last_updated: 2026-07-27
---

# Dynamic Date Values

## Summary
Use `today()` in a date rule so a time-based filter stays current on its own, with no manual editing.

## Details
`today()` is a token you can put in a date-valued rule instead of a fixed date. Radioso resolves it each time retrieval runs, using the current UTC day boundary — so a rule written once keeps meaning "today" tomorrow, without anyone editing it.

It works only with date rules and their comparison operators: `equals`, `not_equals`, `lt`, `lte`, `gt`, and `gte`. The common use is keeping upcoming material fresh — a rule like `dateFrom gte today()` quietly drops anything whose start date has passed. The timing is the part to remember: `today()` is evaluated when the query runs, not when you save the setting, so the window moves with the calendar.
