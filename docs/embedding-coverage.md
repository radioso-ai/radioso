---
title: "Embedding Coverage"
description: "How to read a workspace's embedding coverage, repair the chunks that are missing one, and gather the evidence for retiring the second vector store."
last_updated: 2026-08-27
---

# Embedding Coverage

A chunk is only reachable by semantic search once it has an embedding filed under the workspace's current embedding model. Coverage is the share of a workspace's retrievable chunks that do. Anything short of complete means part of the workspace answers questions and part of it silently does not.

Coverage moves on its own in two situations: while documents are being ingested, and while an embedding-model change re-indexes the workspace. It can also stop moving, and the two ways it stops are worth telling apart before you wait on it.

## Read it in the dashboard

Settings → Providers, on the Embeddings row. It reads as a count and a reason:

- **All 19,318 chunks are indexed.** Nothing to do.
- **14,989 of 19,318 chunks indexed. 12 job(s) queued.** Work is in flight. The document worker drains the queue; check back.
- **14,989 of 19,318 chunks indexed. 3 job(s) failed and will not retry on their own.** Waiting will not fix this. Each failed job keeps its place in the queue's unique key, so the chunks behind it cannot be queued again until the failure is cleared.
- **0 of 19,318 chunks indexed. Set an embedding model to index the rest.** Indexing looks up the workspace's embedding model to decide what to produce. Without one, no work is created however many times you retry.

The same numbers come from `GET /api/v1/settings/ingestion/embedding-coverage`, which needs the `workspace.settings.read` permission and returns `eligibleChunks`, `coveredChunks`, `missingChunks`, `hasEmbeddingProfile`, `queuedJobs`, and `failedJobs`. Eligible means the chunk's document is processed, enabled for retrieval, and not past its retrieval expiry — the same rule retrieval itself applies.

The two job counts cover the workspace's current embedding model only. A job left behind by a model the workspace has moved off, or by an earlier round of the same change, is left out: it closes no gap, and counting it would show a workspace as permanently stuck on work that no re-run will ever touch.

## Repair a workspace with missing chunks

`backend/scripts/backfillEmbeddingCoverage.ts` queues embedding work for every workspace with a gap. Start with a dry run:

```bash
cd backend
pnpm exec tsx ./scripts/backfillEmbeddingCoverage.ts --dry-run
```

It prints one line per workspace and exits non-zero when it finds a gap it cannot move — a workspace with no embedding model, or one holding failed jobs. Set the model, or resolve the failures, then re-run without `--dry-run`.

The work is idempotent: jobs target chunks that are missing an embedding, so a second run after coverage completes queues nothing. The document worker drains the queue by polling, so nothing else needs to be running alongside the script. Re-embedding 50,000 chunks on `text-embedding-3-small` costs roughly $0.25.

The script also runs from a built image as `node ./dist/scripts/backfillEmbeddingCoverage.js`, which is how to reach a database that only accepts private-network connections.

## Retiring the second vector store

Two vector stores hold rows while the backfill runs. `chunk_embeddings` is the
canonical one, and it is where every chunk the backfill has reached lives — along with
every chunk written from now on. `chunks.embedding` and `chunks.embedding_unbounded`
hold the vectors for chunks the backfill has yet to reach, and retrieval merges a
second search over them so those chunks stay findable meanwhile.

Removing that second search, and dropping the columns behind it, depend on the same
evidence. Coverage has to reach 100% first: parity measured over a partly indexed
workspace describes the chunks that happen to be there rather than the workspace.

```bash
cd backend
pnpm exec tsx ./scripts/verifyCanonicalVectorParity.ts
pnpm exec tsx ./scripts/verifyCanonicalVectorParity.ts --workspace <id> --probes 200
pnpm exec tsx ./scripts/verifyCanonicalVectorParity.ts --index-recall --json
```

The script samples a workspace's stored vectors and uses each as a search query, so it
needs no embedding provider and runs against a database clone. For every probe it
compares the two result sets and reports mean recall, the worst single probe,
top-result agreement, and how many distinct chunks the canonical path missed. That last
number is the one that matters: it is the count of chunks that would stop being
findable.

The gate fails when mean recall drops under 99%, when any single probe falls under 90%,
when fewer than 30 probes come back with a non-empty reference, or when the workspace
still has missing chunks. Probes whose reference side is empty cannot pad that floor,
because recall over an empty reference is 100% by arithmetic and counting them would let
a run that compared nothing read as a clean pass. The output reports them either way,
under "probe(s) with an empty reference".

`--index-recall` measures the approximate vector index against an exhaustive scan of the
same rows. It runs the identical query on a connection whose planner cannot use an
index, so the comparison is against real ground truth rather than a benchmark. Run it
where the index was actually built: an index that grew row by row as documents arrived
gives a slightly worse graph than one built in bulk over a finished table, and a clone
restored from a dump rebuilds it in bulk.

`--json` prints the per-workspace summaries as JSON — save that output with the
deployment record. `--seed <text>` picks which vectors become probes, and the same seed
always selects the same ones, so two runs compare like with like. `--workspace <id>`
narrows the run to named workspaces, and `--probes` and `--top-k` set the sample size and
the depth at which the two result sets are compared.

Chunk rows carry their vector in `chunk_embeddings` alone, so the column drop needs no
worker coordination beyond the coverage and parity evidence above.

## Common failure modes

**Coverage sits at zero and the backfill queues nothing.** The workspace has no embedding model. Set one in Settings → Providers; the dashboard line says so directly.

**Coverage stops partway and the queue is empty.** Failed jobs are holding their keys. `failedJobs` in the coverage response is non-zero, and the backfill script names the workspaces in that state and exits non-zero rather than reporting a clean run.

**Coverage reads 100% but the backfill script still exits non-zero.** The two answer different questions. Coverage reports whether the workspace's *active* embedding space is covered, because that is the space retrieval searches. The backfill also schedules the *pending* space during a model transition, so it still has work to enqueue for a workspace whose active space is already complete. Both numbers are correct; finish the backfill before promoting the pending space.

**A chunk's inspector panel shows no embedding width.** The width comes from the chunk's canonical row for the active space. A chunk still waiting on the backfill has none yet, so the panel shows a dash until its embedding job runs.

**Coverage is complete but a specific document is unfindable.** Coverage only counts chunks in documents retrieval would serve. A document that is disabled for retrieval, past its expiry, or not finished processing is excluded from both the numerator and the denominator, so it shows as complete coverage while staying out of results.

## Read next

- [Embedding Model](./settings-docs/ingestion/embedding-model.md) — choosing the model, and what changing it re-indexes
- [Vector Search Indexing](./architecture/vector-search-indexing.md) — how vector storage sits behind adapters
