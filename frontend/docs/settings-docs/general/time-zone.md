---
title: "Workspace Time Zone"
description: "The time zone a workspace reads today's date in, so today, tomorrow and this weekend in a question mean the right day."
last_updated: 2026-11-02
---

# Time zone

## Summary
The day "today", "tomorrow" and "this weekend" mean in answers. UTC until you set one.

## Details
A question like "what's on tomorrow?" is answered against today's date, and today depends on where the visitor is. At 18:00 in Los Angeles it is already the next day in UTC, so a workspace reading today in UTC would answer with the day after tomorrow's events. Set the zone where your visitors are, such as `America/Los_Angeles` or `Europe/Rome`, and the date-range lookup, the upcoming-events order, the answer, the `today()` metadata rule token, and a routine's date slots and lookups all read today in it. A booking routine that follows a "what's on tomorrow?" answer records the same tomorrow the visitor was shown.

A visitor whose browser reports its own time zone gets their own today: the website embed and the hosted chat page send it with every message, and the chat APIs take `userTimeZone`. This setting covers everyone else: email, Slack and voice conversations, Test Chat and evals, Retrieval API and MCP calls, and visitors whose browser reports no zone.

Changing it takes effect on the next message and needs no reprocessing; document dates are calendar dates and stay as they are.
