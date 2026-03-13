# Quickstart: Strict Grounding

## Goal

Verify that out-of-corpus chat questions refuse safely after threshold fallback
is removed, while document-backed questions remain answerable under default
settings.

## Steps

1. Start from the feature branch with backend dependencies installed.
2. Run the backend unit tests covering retrieval threshold behavior.
3. Run the backend contract or integration tests covering:
   - out-of-corpus refusal
   - document-backed answerability
   - unchanged chat response shape
4. Confirm that default retrieval settings use the new candidate-count default.
5. Confirm that saved account-specific retrieval settings are still honored.

## Expected Result

- Out-of-corpus questions return the existing safe refusal response.
- Document-backed questions still return grounded answers with citations.
- The chat API contract remains unchanged.
- No migration or silent rewrite of existing account retrieval settings occurs.
