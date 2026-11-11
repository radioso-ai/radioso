---
title: "Workspace Time Zone"
description: "The time zone a workspace reads today's date in, so today, tomorrow and this weekend in a question, a routine or a document mean the right day."
last_updated: 2026-11-11
---

# Time zone

## Summary
The day "today", "tomorrow" and "this weekend" mean in answers, routines and documents. UTC until you set one.

## Details
A question like "what's on tomorrow?" is answered against today's date, and today depends on where the visitor is. At 18:00 in Los Angeles it is already the next day in UTC, so a workspace reading today in UTC would answer with the day after tomorrow's events. Set the zone where your visitors are, such as `America/Los_Angeles` or `Europe/Rome`, and everything that reads today reads it there: the date-range lookup, the upcoming-events order, the answer, the `today()` metadata rule token, and a routine's date slots and lookups. A booking routine that follows a "what's on tomorrow?" answer records the same tomorrow the visitor was shown.

A conversation turn reads today in the first zone it has:

1. **The zone of the person chatting.** The website embed and the hosted chat page send the visitor's browser zone with every message, Test Chat sends the browser zone of the operator testing, and the chat APIs take `userTimeZone`.
2. **The zone the conversation last ran in.** A routine resumed by an approval click has no visitor request behind it, so it reads the zone of the visitor's last message, the day the routine was parked in.
3. **This setting.** Email, Slack and voice conversations, evals, Retrieval API and MCP calls, and visitors whose browser reports no zone read today here.
4. **UTC.** Only when none of the above names a zone.

Document enrichment reads this setting too. When a document is enriched, a relative date in it, such as "next Friday" or "this weekend", counts from the day the document was created in this zone.

Changing it takes effect on the next message. The dates already stored on documents are calendar dates and do not move when the zone changes; a document picks up the new zone the next time it is enriched.
