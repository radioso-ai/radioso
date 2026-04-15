# Assistant Default Locale

## Summary
Fallback locale for new-chat greetings when the client does not provide a request-specific locale.

## Details
Use a BCP 47 locale tag such as `en`, `en-US`, or `it-IT`. This is a fallback only. Request-level locale hints like `userExpectedLocale` should override it for embedded chat or multi-language sites.
