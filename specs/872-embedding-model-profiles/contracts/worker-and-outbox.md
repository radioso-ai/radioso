# Internal Contract: Worker and Projection Work

The existing AMQP/Cloud Tasks message remains:

```ts
interface DocumentJobQueueMessage {
  jobId: string;
}
```

The durable PostgreSQL row is authoritative for target profile/space, canonical
revision, purpose and workspace generation. An embedding-only job does not mutate
document revision/status, canonical chunks or enrichment state.

Canonical embedding/filter changes and monotonic `vector_index_work` insertion commit
atomically. Dispatch is at-least-once. Adapters must accept duplicates and ignore
operations older than the latest version/tombstone. Deletion before a late upsert must
not resurrect data.

The application reconciler owns leases, retries, acknowledged high-water marks, lag,
and document/workspace/space/deployment rebuilds. Rebuild streams canonical embeddings
through prepare/reset/writer ports without provider calls.

