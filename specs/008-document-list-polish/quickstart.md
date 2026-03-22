# Quickstart: Document List Polish

## Preconditions

- Run from `/tmp/radioso-document-list-polish`.
- Backend dependencies installed in `backend/`, frontend dependencies installed in `frontend/`.
- Test database available for backend integration/contract tests.

## 1) Backend TDD Sequence (Deletion)

1. Run targeted tests expected to fail before implementation:
   - `npm test -- document.contract.test.ts`
   - `npm test -- document-ingestion.test.ts`
   - `npm test -- persistence.integration.test.ts`
2. Implement delete repository/service/route wiring.
3. Re-run the same targeted tests and ensure green.
4. Run broader backend suite slice:
   - `npm test -- contract/document.contract.test.ts integration/persistence.integration.test.ts unit/document-ingestion.test.ts`

## 2) Document List UX Verification (US1 + US2)

1. Start frontend and backend.
2. Open the documents dashboard with mixed title lengths, including long unbroken strings.
3. Verify no horizontal page scroll is required and rows stay in viewport.
4. Verify each row shows one status label and one icon.
5. Click row delete control and confirm:
   - Confirmation appears before deletion.
   - On confirm, row disappears and remains absent after page reload.
6. Repeat delete flow and cancel:
   - Document remains unchanged.
7. Force delete failure (invalid/missing resource):
   - Document remains visible.
   - Clear failure message appears.

## 3) Citation Availability Verification (US3)

1. Ask a question that returns citations.
2. Delete one cited document from documents view.
3. Return to chat and activate the deleted citation marker.
4. Verify unavailable-source feedback appears and current chat answer remains visible.
5. Activate a citation whose document still exists and verify normal document opening.

## 4) Final Validation

- Backend: targeted tests above are green.
- Frontend: `npm run lint` in `frontend/` is green.
- OpenAPI docs include delete endpoint and response semantics.
