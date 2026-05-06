# Greeting Language Fallback

## Summary
Fallback language for automatic new-chat greetings when the client does not provide one.

## Details
Choose the language name operators should see in the setup UI. The backend stores the matching locale tag.

This is a fallback only. Request-level locale hints from public chat override it.

Normal assistant replies still follow the user’s message language.
