# Audience Pulse v1 Quickstart

## Focused backend verification

After the backend slice is implemented, run:

```bash
cd backend
pnpm exec vitest run tests/unit/audiencePulse tests/contract/audiencePulse tests/integration/audiencePulse
pnpm run build
```

With local PostgreSQL available, also run:

```bash
cd ..
pnpm run check:api-contracts
cd backend
pnpm run db:schema:check
```

The tests demonstrate that bearer authentication cannot enter the feature, only the two
typed retrieval outcomes qualify as content gaps, every prompt-evidence source is
reauthorized on a saved read, conditional invalidation cannot erase a newer revision,
and concurrent refreshes across replicas make one provider call.

## Local dashboard walkthrough

1. Start the stack with `./run-dev.sh` and sign into the seeded dashboard workspace.
2. Open Audience Pulse. With no snapshot, verify that the page makes no provider request
   until **Analyze last 30 days** is selected.
3. Run a fixture-backed analysis. Reload the page and verify the saved report loads with
   zero additional provider calls, its fixed period/coverage visible, and sample labels
   near derived interpretations.
4. Open an evidence item and confirm it uses the authorized conversation detail instead
   of exposing data in the URL.
5. Select **Start draft**. The canonical Write document composer must receive the title
   and Markdown bullet questions, while the document list remains unchanged until its
   normal Save action.
6. Switch workspaces before opening the composer and confirm the draft seed cannot cross
   to the other workspace.

## Broader gate

Before creating the pull request, run:

```bash
pnpm run ci:local -- origin/main
```
