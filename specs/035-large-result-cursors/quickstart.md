# Quickstart: High-Cardinality Cursor Hardening Validation

1. Seed a workspace with a large document set and enough conversations,
   messages, and search-history rows to exercise high-cardinality routes.
2. Verify these routes return bounded summary/detail windows only:
   - `GET /api/v1/documents`
   - `GET /api/v1/chat/history`
   - `GET /api/v1/public/chat/:token`
   - `GET /api/v1/document/search/history`
   - `GET /api/v1/chat/history/:conversationId`
   - `GET /api/v1/public/chat/:token/history/:conversationId`
3. Request consecutive windows using the emitted cursor and confirm:
   - no duplicates
   - no skipped rows
   - stable ordering under timestamp ties
4. Create and delete rows between requests and confirm continuation remains
   bounded and predictable.
5. Confirm frontend list/detail surfaces fetch only the visible window and do
   not trigger full-collection reloads after routine actions.
6. Regenerate OpenAPI outputs and verify contracts match runtime behavior.
