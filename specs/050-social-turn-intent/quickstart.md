# Quickstart: Model-Level Social Turn Intent

Use these scenarios to validate the feature after implementation.

## 1. Social-only greeting does not hit grounded miss

1. Start a conversation in a workspace with proactive greeting enabled.
2. Send `Hi Vikram`.
3. Confirm the reply is a brief acknowledgement in the same language.
4. Confirm the reply is **not** the unsupported-answer grounded-miss fallback.

## 2. Social-only thanks still follows answer instructions

1. Configure a custom answer instruction that makes replies concise and
   practical.
2. Send `Thanks`.
3. Confirm the reply stays brief and reflects that answer guidance even though
   retrieval did not run.

## 3. Mixed turn still retrieves

1. Upload grounded content that can answer a concrete question.
2. Send `Thanks, and what courses are coming up?`
3. Confirm the answer addresses the substantive question with normal grounded
   retrieval behavior.
4. Confirm the turn is not reduced to a social acknowledgement only.

## 4. Identity-only question bypasses regex and retrieval fallback

1. Configure assistant identity fields for the workspace.
2. Ask `Who are you?`
3. Confirm the answer uses the configured identity.
4. Confirm it does not return document-grounded miss copy.

## 5. Unusable intent output fails safely

1. Force the interpretation gateway to return malformed output in a test.
2. Send a substantive grounded question.
3. Confirm the system falls back to the normal retrieval-oriented path rather
   than using deterministic local routing.

## 6. Diagnostics show the chosen path

1. Exercise a social-only turn, an identity-only turn, and a mixed turn.
2. Inspect stored diagnostics or audit metadata.
3. Confirm each turn records whether retrieval was skipped and which response
   intent was used.
