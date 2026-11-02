---
title: "Dynamic Date Values"
description: "Using the today() token in date metadata rules so time-based filters stay current without manual edits."
last_updated: 2026-11-02
---

# Dynamic Date Values

## Summary
Use `today()` in a date rule so a time-based filter stays current on its own, with no manual editing.

## Details
`today()` is a token you can put in a date-valued rule instead of a fixed date. Radioso resolves it each time retrieval runs, to today's date in the visitor's time zone, or the workspace time zone when the visitor's browser reports none (UTC until you set one) — so a rule written once keeps meaning "today" tomorrow, without anyone editing it.

`today()` is a calendar date, and date values such as `2026-11-02`, the usual form for event dates, compare against it day for day. A value with a time of day compares against that date at 00:00 UTC, not the start of the visitor's day: for a visitor in Los Angeles on 2 November, `2026-11-02T05:00:00Z`, which is 21:00 on 1 November there, still passes `dateFrom gte today()`.

It works only with date rules and their comparison operators: `equals`, `not_equals`, `lt`, `lte`, `gt`, and `gte`. The common use is keeping upcoming material fresh — a rule like `dateFrom gte today()` quietly drops anything whose start date has passed. The timing is the part to remember: `today()` is evaluated when the query runs, not when you save the setting, so the window moves with the calendar.
