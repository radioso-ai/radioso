---
title: "Privacy Notice"
description: "The line and policy link a visitor is shown before their first message, per language, and how each conversation records which one it saw."
last_updated: 2026-10-19
---

# Privacy Notice

## Summary
One line and a link to your privacy policy, shown word for word before a visitor's first message and sent with an email conversation's first reply.

## Details
Visitors often type personal details into a chat before they think about where the words go. The privacy notice tells them up front, in your words: one line such as "We use your messages to answer you and keep them for 30 days.", followed by a link to your full policy. It informs; it asks for nothing, so it is not consent.

Write one notice per language, each a line of up to 200 characters and an http or https link of up to 500. The website embed, the public chat link and Test Chat show it with the agent's name and AI marker, as one quiet block above the conversation, in the visitor's language; a visitor whose language has no notice sees the English one, or else the first language you wrote. The link's label ("Privacy policy") comes from the chat's wording, so you can rename it per language under **Wording**. An email conversation's first reply carries the line and the link below the reply, in the agent's default language. A call started from the embed hands the line to ElevenLabs as the `radioso_privacy_notice` dynamic variable, which the call says when the ElevenLabs agent's first message starts with `{{radioso_privacy_notice}}`.

Each notice has a version made from its language, line and link, shown under it once saved. A conversation records the version its visitor was shown, and the conversation's **Visitor** panel shows it. Changing a notice's words or link gives it a new version; conversations already recorded keep theirs. A visitor whose page still showed the notice you replaced gets no record, because that version is no longer the agent's; the website embed's configuration is cached for up to five minutes, so expect a short window after each change.

Leave every language out and nothing is shown.
