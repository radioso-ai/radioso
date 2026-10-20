---
title: "Conversation Retention"
description: "How many days a workspace keeps a conversation after its last activity before the retention sweep erases it with everything derived from it."
last_updated: 2026-10-19
---

# Conversation retention

## Summary
Erase conversations after a stretch with no activity. Off keeps them until someone deletes them.

## Details
Pick how many days a conversation may sit idle — no message from the visitor, the agent or a teammate — before Radioso erases it, with its summary, routine state, eval snapshots, inbound mail and the audit events that carry its content. The window takes whole days from 7 to 3650; **Keep until deleted** turns retention off, which is where every workspace starts.

A year suits most support work. A workspace whose visitors share health or other sensitive details does well with 90 days.

A sweep runs every 15 minutes and erases what is already past the window, so saving a first or shorter window asks you to confirm: erased conversations cannot be restored. Only owners and admins can change it, because it deletes history. [Data retention](https://docs.radioso.ai/operators/data-retention) lists the fixed windows on summaries, routine state and raw email, and how long backups and logs keep deleted data.
