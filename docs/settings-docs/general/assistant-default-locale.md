---
title: "Greeting Language Fallback"
description: "Fallback language for automatic new-chat greetings when the client does not supply a locale hint."
last_updated: 2026-07-27
---

# Greeting Language Fallback

## Summary
The language an automatic greeting uses when the client sends no language hint of its own.

## Details
This sets the language for a proactive greeting only when the incoming request carries no locale of its own. Pick the language by name in the setup UI; Radioso stores the matching locale tag.

It is a fallback, not a lock. A public-chat request that supplies its own locale overrides it, and once a visitor sends a message the agent replies in the language they wrote in. So this mainly matters for the very first, visitor-silent greeting — for example, defaulting an embed to Estonian on a mostly-Estonian site, while still answering an English question in English.
