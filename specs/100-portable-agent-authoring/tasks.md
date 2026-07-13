# Tasks: Portable Agent Authoring — US1 + FR-016 stage 1

**Input**: plan.md, research.md, data-model.md (this directory)
**Scope**: US1 only. Checkboxes are updated as work lands. Backend follows TDD:
test tasks precede implementation tasks and must fail first.

## Phase A — `@radioso/routine-definition` (FR-016 stage 1)

- [x] A1. Scaffold `packages/routine-definition` (compiled-dist convention per
      research.md: package.json, tsconfig, vitest config; dep: zod only).
- [x] A2. Move the full contents of `backend/src/modules/routines/domain.ts`
      into `packages/routine-definition/src/index.ts` (limits, enums, schemas,
      inferred types, `routineGuardProvenance`). No semantic edits.
- [x] A3. Replace `backend/src/modules/routines/domain.ts` with a pure
      re-export of the package; add `@radioso/routine-definition: workspace:*`
      to backend deps; wire package build into backend `build:workspace-deps`
      and `predev:*` chains.
- [x] A4. Add package-level schema tests (happy path + one rejection per
      schema family) in `packages/routine-definition/tests/`; keep the three
      existing backend test files referencing the old path green unchanged.
- [ ] A5. Verify: package `tsc --noEmit`, backend `tsc --noEmit`,
      `pnpm exec vitest run tests/unit/routines tests/unit/routine-approval-authoring.test.ts`
      (backend), package vitest.

## Phase B — `@radioso/routine-markdown` (grammar package)

- [x] B1. Scaffold `packages/routine-markdown` (same convention; dep:
      `@radioso/routine-definition` only).
- [x] B2 (RED). Move `frontend/tests/unit/routine-prose-tokens.test.ts` corpus
      into the package test suite; add failing tests for: (a) frontmatter
      `grammar: 1` always emitted by serialize; (b) parse of missing version =
      v1; (c) parse of unsupported version → typed diagnostic, no partial doc;
      (d) `contextVariableRef` binding token round-trip (serialize→parse→equal);
      (e) `canonicalize()` idempotence (canonicalize∘canonicalize = canonicalize).
- [x] B3 (GREEN). Move `frontend/lib/routine-prose-tokens.ts` into the package;
      implement version frontmatter, `contextVariableRef` token, `canonicalize`,
      typed `ParseDiagnostic { line, code, message }` (grammar errors must carry
      line info — upgrade silent-skip paths in the parser where needed).
- [x] B4. Move the doc⇄draft mapping (`routineToChipDoc`/`draftFromChipDoc`
      definition-level halves) from `frontend/lib/routine-prose.ts` into the
      package as `draftToDoc`/`docToDraftInput` typed against
      `@radioso/routine-definition`; chip-specific UI state stays in frontend.
- [ ] B5. Package exports: `parse`, `serialize`, `canonicalize`,
      `GRAMMAR_VERSION`, `looksLikeRoutineProse`, doc/draft mapping, diagnostic
      types. Verify: package tsc + vitest (full corpus green).

## Phase C — backend portable API (TDD)

- [ ] C1 (RED). `backend/tests/unit/routines/portableDocument.test.ts`:
      definition→markdown projection (canonical, version emitted);
      markdown→draft-input parse reusing package; grammar-error mapping to
      400-shaped diagnostics; SC-005 guard (module has no model-gateway import —
      assert via dependency shape, not grep).
- [ ] C2 (RED). Route tests (Supertest, existing agentRoutes test patterns):
      GET portable (canonical envelope), PUT portable (update → canonical
      response, ids stable), POST portable create (201, ids injected), POST
      canonicalize (no persistence — assert repository untouched), 400
      diagnostics, 422 validator pass-through, authz parity with structured
      routine endpoints.
- [ ] C3 (GREEN). Implement `backend/src/modules/routines/portableDocument.ts`
      (pure mapper) + thin service entry points that reuse the existing
      structured save/validate path; handlers in `agentRoutes.ts` per existing
      handler-per-operation style; canonicalize route placement per research.md.
- [ ] C4. Observability (FR-009): structured log + counter on portable
      create/update/canonicalize failures (code only, never content); audit
      parity with structured routine writes if those emit audit events (match,
      don't invent).
- [ ] C5. OpenAPI: register endpoints + envelope schemas in
      `backend/src/app/http/openapi/document.ts`; `pnpm run generate:openapi`;
      update contract tests; `typescript-sdk` `pnpm run sync` (generated types
      only — no client wrapper methods, that is US3).
- [ ] C6. Verify: backend `tsc --noEmit`; targeted vitest (new units + routes +
      contract bucket); confirm generated openapi.yaml/json diff contains only
      the new paths/schemas.

## Phase D — frontend swap + chip parity

- [ ] D1. Frontend consumes `@radioso/routine-markdown` (workspace dep); update
      `routine-prose.ts` + `routine-chip-editor.tsx` imports; DELETE
      `frontend/lib/routine-prose-tokens.ts` and its local test file (corpus now
      lives in the package).
- [ ] D2. Chip layer (FR-004a): `routine-prose.ts` chip model represents
      `contextVariableRef` bindings; unit tests (non-visual, transform-level)
      for open→edit→save preservation of all three binding kinds.
- [ ] D3. Playwright journey: create context-bound routine via API, open in
      chip editor, edit an unrelated step, save, read back via API — binding
      intact. Reuse existing routine-prose-clipboard spec patterns.
- [ ] D4. Verify: frontend lint + targeted vitest + the new/existing routine
      Playwright specs; `grep -r routine-prose-tokens frontend` returns nothing.

## Phase E — docs (Principle IX)

- [ ] E1. Read `docs/document-writer-prompt.md` first. New grammar format
      reference (public contract: frontmatter incl. `grammar:`, tokens, guards,
      bindings incl. context variables, canonical-form rules, versioning
      policy) under `docs/`.
- [ ] E2. Portable routines API section (endpoints, envelope, canonicalize
      "commit back" workflow, error shapes) in `docs/` + docs-portal page.
- [ ] E3. Check for existing routine-authoring docs that are now stale
      (mention of copy/paste text form) and update in place.

## Phase F — verification & delivery gates

- [ ] F1. Independent end-to-end verification (orchestrator, not Codex):
      run the real backend, author a routine via portable POST covering every
      grammar element, publish, GET portable, PUT a mutation, verify chip
      editor renders it; confirm zero model-provider calls on the path.
- [ ] F2. Senior engineer review loop (≤3 passes), then one EM pass.
- [ ] F3. `pnpm run ci:local -- origin/main` (with vector-enabled integration
      DB; grep the real exit code); push; PR with validation evidence and
      artifact links.
