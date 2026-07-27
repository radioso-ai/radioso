# Internal Contract: Vector Adapter

```ts
interface VectorCapabilitiesPort {
  describe(): Promise<VectorCapabilities>;
}

interface VectorWriterPort {
  apply(mutation: VersionedVectorMutation): Promise<MutationAck>;
}

interface VectorCandidateSearchPort {
  search(query: CandidateQuery): Promise<readonly RankedChunkId[]>;
}

interface VectorAdminPort {
  prepareSpace(space: LogicalVectorSpace): Promise<Readiness>;
  resetSpace(spaceId: string, rebuildGeneration: bigint): Promise<void>;
  readiness(spaceId: string): Promise<Readiness>;
}
```

Capabilities declare dimension ranges, cosine support, portable filters, batch limits,
exact/accelerated modes and consistency/readiness. Mutations use logical IDs,
monotonic versions and portable workspace/space/source/metadata/eligibility/expiry
payloads. Search returns identifiers and cosine scores in `[-1,1]`; higher is better,
thresholds are inclusive and chunk ID breaks ties.

Adapters do not receive database clients or SQL, read PostgreSQL, hydrate chunks,
authorize results, coordinate rebuilds, or expose backend-specific controls. The
application owns durable outbox state, lag, retries and rebuild streaming.

