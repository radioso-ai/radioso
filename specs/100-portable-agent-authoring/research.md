# Research: Portable Agent Authoring — US1

All spec-level open questions were resolved at approval (spec.md → Resolved
Decisions). This file records the repo ground truth that shapes implementation.

## Decision: compiled-dist package convention

- **Decision**: `@radioso/routine-definition` and `@radioso/routine-markdown` are
  compiled packages (tsc → dist, `main`+`types` pointing at dist), added to
  backend `build:workspace-deps` and `predev:*` chains.
- **Rationale**: backend consumes workspace packages as built output
  (`conversation-engine` pattern, `backend/package.json:10-23`); Next.js consumes
  compiled ESM+d.ts without a `transpilePackages` entry. The alternative
  (source-exporting like `@radioso/ui`, `packages/ui/package.json` exports `.tsx`
  source + `frontend/next.config` `transpilePackages`) works only for
  frontend-only packages — backend tsc will not compile `.ts` out of
  node_modules.
- **Alternatives considered**: types-only package like `conversation-contract`
  (exports `index.d.ts`, build = typecheck) — rejected: both packages carry
  runtime code (Zod schemas, parser/serializer).

## Decision: hoist mechanics for domain.ts

- Ground truth: `backend/src/modules/routines/domain.ts` (282 lines) exports
  limits, enum arrays, all routine Zod schemas, inferred types, and one pure
  helper (`routineGuardProvenance`). Its importers are all inside
  `backend/src/modules/routines/` (8 files incl. `public.ts` barrel) plus 3 test
  files referencing the path.
- **Decision**: move contents to `@radioso/routine-definition`;
  `backend/src/modules/routines/domain.ts` becomes a pure re-export
  (`export * from "@radioso/routine-definition"`), keeping the module barrel and
  all existing import sites stable. This is a move (single source of truth), not
  a copy; the shim is a consumption seam, not duplication.
- **Rationale**: minimizes churn and review noise; US3/US4 can later flip
  internal imports to the package directly if the shim proves annoying.

## Decision: grammar extraction scope

- Ground truth: `frontend/lib/routine-prose-tokens.ts` (633 lines) is the
  grammar (serialize/parse/`looksLikeRoutineProse`); its non-test consumers are
  `frontend/lib/routine-prose.ts` (1121 lines, chip-document model — stays
  frontend-local per spec) and
  `frontend/components/dashboard/settings/routine-chip-editor.tsx`. Round-trip
  corpus: `frontend/tests/unit/routine-prose-tokens.test.ts`.
- **Decision**: move tokens module + its test corpus into
  `packages/routine-markdown`; the package's public API is
  `parse(content, options)`, `serialize(definition | doc)`, `canonicalize(content)`,
  `GRAMMAR_VERSION`, plus typed diagnostics. Frontend imports the package;
  `routine-prose-tokens.ts` is deleted (SC-001 requires it gone).
- The grammar today speaks the chip-document shape (`ProseDoc`), not
  `RoutineDefinition` directly. The package must expose the definition-level
  mapping (doc ⇄ draft input) so the backend never learns chip concerns. The
  existing `routineToChipDoc`/`draftFromChipDoc` split in `routine-prose.ts`
  marks the boundary: the doc⇄draft mapping moves into the package; chip-editor
  UI state stays in the frontend.

## Decision: grammar versioning

- **Decision**: frontmatter key `grammar: <int>`; serializer always emits it;
  parser treats missing as version 1 (the pre-versioning grammar, defined not
  guessed) and rejects unsupported versions with a typed diagnostic. This
  delivery ships `GRAMMAR_VERSION = 1` — i.e. v1 is *defined* as today's grammar
  plus the `contextVariableRef` binding token (FR-004), and the emitted
  frontmatter makes future migration possible (FR-001).

## Decision: API shape (per resolved OQ-005/OQ-006)

- All `application/json`:
  - `GET /api/v1/agents/{agentId}/routines/{routineId}/portable` →
    `{ grammarVersion, content }` (canonical form, always).
  - `PUT` same path with `{ grammarVersion, content }` → parses, then reuses the
    exact structured update path (validation identical); returns the canonical
    document (ids injected — the "commit back" flow).
  - `POST /api/v1/agents/{agentId}/routines/portable` → create from envelope,
    returns routine id + canonical document.
  - `POST /api/v1/routines/portable/canonicalize` → parse+serialize, no
    persistence, no agent scoping needed beyond auth; returns canonical document
    or diagnostics. (Placed workspace-level since it touches no agent state —
    final path to be confirmed against existing route grouping at
    implementation.)
- Grammar errors → 400 with line/token diagnostics; semantic validation errors →
  existing 422 + validator diagnostic codes (spec FR-005).

## Decision: SDK regen scope

- `typescript-sdk` has `sync` (OpenAPI → generated types) — run it; generated
  types will include the new endpoints. Hand-written client wrapper methods are
  US3 and MUST NOT be added on this branch.

## Codex operational notes (orchestration)

- Codex must not run `pnpm run build` (sandbox EPERM hang); verification via
  `tsc --noEmit` + `pnpm exec vitest run <path>`. Package dist builds are run by
  the orchestrator when needed.
- `pnpm test -- <path>` ignores the filter in backend; use
  `pnpm exec vitest run <path>`.
