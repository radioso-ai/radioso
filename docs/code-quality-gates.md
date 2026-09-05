---
title: "Lint and Dead-Code Gates"
description: "How the workspace lint run and the dead-code ratchet work, what each one catches, and what to do when they fail."
last_updated: 2026-09-05
---

# Lint and Dead-Code Gates

Two checks run across the whole pnpm workspace and gate every pull request. Between them they catch the things a typechecker and a test suite let through: imports nobody uses, promises nobody awaits, and exports nobody imports.

Run both from the repo root:

```bash
pnpm run lint              # ESLint across backend, frontend, packages, ee, docs-portal
pnpm run lint:fix          # the same, applying every safe autofix
pnpm run lint:dead-code    # the full dead-code report
pnpm run lint:dead-code:ci # the gate CI runs
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

The full report is large, so the gate is a ratchet rather than a pass/fail on the total. `scripts/knip-ratchet.mjs` applies two rules:

1. **A finding that isn't in `knip-baseline.json` fails the build.** New dead code cannot enter the repo. This includes dead code you created somewhere else by deleting the last caller of an export you never opened.
2. **A baselined finding in a file your change touches also fails the build.** You aren't asked to clean the whole repo, only the part you were already editing.

The baseline is read as of the merge base, so appending to it in the same commit exempts nothing. The one exception is the change that first creates the baseline: there is nothing at the merge base to compare against, so rule 2 has no prior finding to point at and starts applying to the change after it.

### When the ratchet fails

For a new finding, delete the dead code or wire it up. If it's a false positive — a file loaded dynamically, an export consumed by something outside the import graph — declare the entry point in `knip.json` rather than baselining it.

For a finding in a file you touched, clean it up while you're in there.

When you remove dead code, bank it:

```bash
pnpm run lint:dead-code:baseline
```

That rewrites `knip-baseline.json`; commit it with your change. The ratchet reports how far the baseline has drifted from reality on every run, so a stale baseline is visible rather than silent.

## Test files and their tsconfigs

Type-aware linting needs every file to belong to a TypeScript project. Each package therefore keeps two configs, the split that `backend/` and `packages/radioso-mcp-server/` already used:

- `tsconfig.json` — the wide check project. Covers `src`, `tests`, and `vitest.config.ts`, with `noEmit: true`.
- `tsconfig.build.json` — the narrow emit project. Extends the wide one, restores `rootDir` / `outDir` / `declaration`, and covers `src` alone. This is what `pnpm run build` uses.

Adding a test directory to a package means adding it to the wide `include`, or its files lint without type information.

## Common failure modes

**`Parsing error: … was not found by the project service`** — the file belongs to no tsconfig. Add it to the wide `tsconfig.json` of its package.

**Lint passes locally and fails in CI** — CI builds the workspace packages first. Without their `.d.ts` files, type-aware rules see `any` and quietly find less than CI does.

**`knip-ratchet` flags a file you only reformatted** — it treats any changed file as touched. Clean the finding, or revert the incidental change.

## Read next

- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — the full local check before opening a pull request.
- [`docs/architecture/code-map.md`](./architecture/code-map.md) — finding the module that owns the code you're about to delete.
