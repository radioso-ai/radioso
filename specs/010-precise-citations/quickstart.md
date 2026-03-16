# Quickstart: Precise Citation Placement

## 1. Write failing backend tests first

Run targeted backend tests that prove the current heuristic behavior is insufficient and define the exact-placement contract:

```bash
cd /Users/dm/code/hivec-precise-citations/backend
npm run test:unit -- tests/unit/answer-presentation.test.ts tests/unit/chat-service-streaming.test.ts
npm run test:contract -- tests/contract/chat.contract.test.ts
```

## 2. Implement deterministic citation normalization

Update prompt construction, add the citation-anchor parser, and route completed JSON and SSE answers through the same normalization path.

## 3. Run focused backend verification

```bash
cd /Users/dm/code/hivec-precise-citations/backend
npm run test:unit -- tests/unit/answer-presentation.test.ts tests/unit/chat-service-streaming.test.ts
npm run test:contract -- tests/contract/chat.contract.test.ts
npm run test:integration -- tests/integration/chat.integration.test.ts
npm run build
```

## 4. Run frontend verification

```bash
cd /Users/dm/code/hivec-precise-citations/frontend
npm run build
```

## 5. Manual acceptance checks

- Ask a question that produces multiple claims and verify inline citation markers land on the intended claims.
- Confirm no marker appears inside prices, URLs, or connective prose.
- Verify streamed answers finalize into the same placement as non-streamed answers.
- Confirm malformed anchors in test fixtures do not leak raw placeholder syntax to the final answer.
