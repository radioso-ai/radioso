---
title: "Code Quality Gates"
description: "How the workspace lint run, the dead-code, file-size, and architecture ratchets, and the route coverage check work, what each one catches, and what to do when they fail."
last_updated: 2026-10-27
---

# Code Quality Gates

These checks gate every pull request and every push to `main`. They catch what a typechecker and a test suite let through: imports nobody uses, promises nobody awaits, exports nobody imports, files that keep growing, modules that import each other in a circle, and routes the API contract never mentions.

The workspace-wide checks run from the repo root:

```bash
pnpm run lint                    # ESLint across backend, frontend, packages, ee, docs-portal
pnpm run lint:fix                # the same, applying every safe autofix
pnpm run lint:dead-code          # the full dead-code report
pnpm run lint:dead-code:ci       # the dead-code gate CI runs
pnpm run lint:file-size          # the file-size gate CI runs
pnpm run lint:file-size:baseline # re-record file-size-baseline.json after shrinking a file
```

The backend's import-graph checks run from `backend/`:

```bash
pnpm run lint                       # boundary rules, architecture ratchet, raw SQL, detached methods
pnpm run lint:boundaries            # dependency-cruiser boundary rules alone
pnpm run lint:architecture          # module cycles and dependency direction
pnpm run lint:architecture:baseline # re-record the architecture baseline after fixing an edge
```

A full lint pass takes about 80 seconds and needs headroom: `NODE_OPTIONS=--max-old-space-size=8192`. The `pnpm run lint` script sets it for you.

Type-aware rules read each workspace package through its built `.d.ts`, so build the packages before linting a fresh checkout:

```bash
pnpm --filter "./packages/*" --filter "./ee/packages/*" run build
```

## What ESLint checks

One config at the repo root — `eslint.config.mjs` — covers every area, so "common style" means the same thing in `backend/` as in `packages/`. Each area layers on top of the shared base rather than restating it: the two Next.js apps add the React and Core Web Vitals rules, and test files relax the rules that only fire on test doubles.

The type-aware rules are chosen one at a time rather than taken as a preset. The preset's `no-unsafe-*` and `require-await` rules fire about seven thousand times on mock-heavy test code, which would produce a gate nobody could keep green. What's left is the set that finds real defects: an un-awaited promise that drops a rejection, a value interpolated into a string that renders as `[object Object]`, a `throw` of something that isn't an `Error`, a `finally` block that swallows the exception it was meant to clean up after.

Three scoping decisions are worth knowing about, because each looks like a gap until you hit the reason:

- **`no-misused-promises` allows async JSX attributes.** `onClick={async () => …}` is how React is written, and React handles the promise. The argument form — a promise handed to `setTimeout` or an event listener — stays an error, because that one really does drop rejections.
- **`no-control-regex` is off.** Several input validators reject C0 control characters on purpose, which is exactly the pattern this rule reads as a typo.
- **Test files allow `any`, unbound method references, `async` without `await`, and `async function*` without `yield`.** These are what a mock is.

### When a rule is wrong about your code

Suppress it inline, with a reason:

```ts
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- pins the literal column names; without it the ternary widens to string[] and Kysely rejects it.
```

The `-- <reason>` half is the point. A bare disable comment tells the next reader nothing, and the reason is what lets someone remove the suppression later when the underlying cause is gone.

That particular rule is worth a warning. `no-unnecessary-type-assertion` judges an assertion by whether it changes the type where it stands, so it flags assertions whose job is to stop TypeScript from *narrowing* a literal — `'variable' as RoutineChipKind`, `{} as Record<string, …>`, a `as const`-style pin on a ternary. Removing one of those typechecks fine in its own file and breaks a consumer several files away. Run `tsc` after `pnpm run lint:fix`, not just the tests.

## What the dead-code ratchet checks

`knip` walks the import graph from each package's real entry points and reports what nothing reaches: unused files, unused exports, unused exported types. The configuration lives in `knip.json`, and entry points that no static analysis could find — the launcher script served as a raw asset, the Enterprise feature manifests loaded by path — are declared there.

The full report is large, so the gate is a ratchet rather than a pass/fail on the total. `scripts/knip-ratchet.mjs` applies three rules:

1. **A finding that isn't in `knip-baseline.json` fails the build.** New dead code cannot enter the repo. This includes dead code you created somewhere else by deleting the last caller of an export you never opened.
2. **A baselined finding in a file your change touches also fails the build.** You aren't asked to clean the whole repo, only the part you were already editing.
3. **A baseline that no longer matches the findings fails the build.** Both directions count: a key whose finding is gone, and a finding with no key. A key that outlives its finding would sit in the baseline exempting that exact `kind|file|name`, so the same dead code could come back later and rule 1 would wave it through.

The baseline is read as of the merge base, so appending to it in the same commit exempts nothing. The one exception is the change that first creates the baseline: there is nothing at the merge base to compare against, so rule 2 has no prior finding to point at and starts applying to the change after it.

### When the ratchet fails

For a new finding, delete the dead code or wire it up. If it's a false positive — a file loaded dynamically, an export consumed by something outside the import graph — declare the entry point in `knip.json` rather than baselining it.

For a finding in a file you touched, clean it up while you're in there.

When you remove dead code, bank it:

```bash
pnpm run lint:dead-code:baseline
```

That rewrites `knip-baseline.json`; commit it with your change. Rule 3 means this is not optional — removing dead code without re-recording fails the build, which is what keeps the baseline from accumulating keys that outlive the findings they stand for.

## What the file-size ratchet checks

Small, named modules are easier to review, test, and hand to an agent than one file that does everything. `scripts/file-size-ratchet.mjs` holds production source to 1,000 lines, counted the way `wc -l` counts them.

It reads git-tracked files under `backend/src`, `frontend/app`, `frontend/components`, `frontend/hooks`, `frontend/lib`, `typescript-sdk/src`, and each package in `packages/` and `ee/packages/` (its `src/`, or the package root when the package keeps its source there). Tests, `generated/` directories, and files whose first lines carry a generated-code header are out of scope.

Files already past the limit are recorded in `file-size-baseline.json` with their current line count, and three rules apply:

1. **A file over 1,000 lines that isn't in the baseline fails the build.** Split it before it lands.
2. **A baselined file that grows past its recorded count fails the build.** The recorded count is a ceiling, so adding a feature to a large file means extracting something first.
3. **A baseline entry that no longer matches the file fails the build** — the file shrank, dropped under the limit, or moved. Re-record with `pnpm run lint:file-size:baseline` and commit the result, so the ceiling follows the file down.

`--update` only lowers ceilings and drops entries. Recording a new oversized file or a higher count takes `node scripts/file-size-ratchet.mjs --update --allow-growth`, which shows up in the baseline diff for a reviewer to question.

## What the architecture ratchet checks

`backend/dependency-cruiser.config.cjs` holds the boundary rules the backend already meets, as errors: modules import each other through `public.ts` or `contracts/`, vendor SDKs stay behind their adapters, and so on. `pnpm run lint:boundaries` runs it.

Two rules from `AGENTS.md` are tracked by `backend/scripts/checkArchitectureRatchet.mjs` instead, because existing code breaks them:

- **Modules form no import cycles.** Imports from one module's files into another's are collapsed to module-to-module edges (`chat -> retrieval`), and any edge that lies on a cycle is a finding. Dependency direction only means something when the module graph is acyclic. The check follows direct module-to-module imports; a path that runs through the repositories in `src/db`, which modules import and which import module types, is outside it.
- **Dependencies point down.** `src/modules` never imports `src/app` (`no-module-imports-app`), and `src/shared` imports neither `src/modules` (`no-shared-imports-modules`) nor `src/app` (`no-shared-imports-app`). A finding is keyed by the importing area and the imported file — `modules/auth -> src/app/config/env.ts` — so splitting or moving a file inside its module keeps its baselined entry.

Type-only imports count for both, the same as for the boundary rules.

Today's findings are recorded in `backend/scripts/architectureRatchetBaseline.json`, and the ratchet works like the file-size one: a finding outside the baseline fails, a baseline entry that no longer occurs fails until you re-record with `pnpm run lint:architecture:baseline`, and `--update` refuses to add entries unless you pass `--allow-growth`.

A failure names the edge and the path that closes the cycle:

```text
✖ New module edges inside an import cycle:
  documentTypes -> chat  (closed by chat -> documents -> documentTypes)
```

To fix one, invert the dependency: have the lower-level module own the port or type, and let the higher-level module depend on it. For a direction finding, pass the dependency in as a constructor or route-factory argument wired in `src/app/`, or move the shared type into `src/shared`.

## Routes and the OpenAPI document

The OpenAPI document built by `backend/src/app/http/openapi/openApiDocument.ts` is the contract three other things are generated or checked from: the TypeScript SDK snapshot, the MCP server's generated types, and the operator copilot's coverage map. A route that's mounted but never registered there is invisible to all three.

`backend/tests/contract/openapi-route-coverage.contract.test.ts` builds the real app, walks every mounted router, and compares every route it finds with the document's operations, in both directions. Routes that sit outside the API contract altogether, such as connector webhooks under `/api/connectors`, are listed by prefix in `outOfScopeMountPrefixes` with a reason. A route under any other prefix, including a brand-new one, is checked like the rest:

- **A mounted route with no OpenAPI operation fails the test** unless it's in `undocumentedRouteExclusions` with a specific reason. The groups there are email-link landing pages, OAuth protocol endpoints, internal service calls, the voice vendor callback, frontend telemetry beacons, and a "should be added to OpenAPI" group that lists real API surface still waiting for its registration.
- **An OpenAPI operation with no mounted route fails the test** unless it's in `reverseRouteMismatches`, which names where the route actually lives — the workspace event stream, for example, is served by the realtime process.
- **An exclusion or out-of-scope prefix that no longer matches a route fails the test**, so it can't sit there and exempt an unrelated route later.

When you add a route, register it in the OpenAPI registry, then run `cd typescript-sdk && pnpm run sync` and give its operationId an entry in `backend/tests/unit/operatorCopilot/catalogCoverage.ts`. Add an exclusion only when the route isn't an API operation at all, and say why in the reason.

## Test files and their tsconfigs

Type-aware linting needs every file to belong to a TypeScript project. Each package therefore keeps two configs, the split that `backend/` and `packages/radioso-mcp-server/` already used:

- `tsconfig.json` — the wide check project. Covers `src`, `tests`, and `vitest.config.ts`, with `noEmit: true`.
- `tsconfig.build.json` — the narrow emit project. Extends the wide one, restores `rootDir` / `outDir` / `declaration`, and covers `src` alone. This is what `pnpm run build` uses.

Adding a test directory to a package means adding it to the wide `include`, or its files lint without type information.

Vitest strips types, so a test can drift from the domain types it exercises — a fixture missing a field a port gained, a mock returning last year's shape — and the suite still runs green. Backend CI closes that gap on a push or pull request: the `backend-build-openapi` job builds the backend (`pnpm run build`, which runs `build:workspace-deps` first) and then runs `tsc -p tsconfig.json` across `src`, `tests`, and `scripts`, so a type that only a test imports is checked too. Run the same check locally from `backend/`:

```bash
pnpm run typecheck   # builds workspace deps, then tsc -p tsconfig.json --noEmit
```

A fixture that falls behind a domain type fails here, not in a flaky test months later.

## Common failure modes

**`Parsing error: … was not found by the project service`** — the file belongs to no tsconfig. Add it to the wide `tsconfig.json` of its package.

**Lint passes locally and fails in CI** — CI builds the workspace packages first. Without their `.d.ts` files, type-aware rules see `any` and quietly find less than CI does.

**`knip-ratchet` flags a file you only reformatted** — it treats any changed file as touched. Clean the finding, or revert the incidental change.

**The file-size or architecture ratchet fails on a file you made smaller, or an import you removed** — the baseline has to follow the improvement down. Run `pnpm run lint:file-size:baseline` (repo root) or `pnpm run lint:architecture:baseline` (`backend/`) and commit the baseline.

**A new module edge lands inside a cycle even though the import looks harmless** — module-level cycles are transitive. The failure prints the path that closes the cycle; break any edge on it, usually by moving a type into the lower module's `contracts/`.

## Read next

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — the full local check before opening a pull request.
- [`docs/architecture/code-map.md`](./architecture/code-map.md) — finding the module that owns the code you're about to delete.
