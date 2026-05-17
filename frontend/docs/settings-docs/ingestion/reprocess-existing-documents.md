# Reprocess Existing Documents

## Summary
Queue current documents again so they pick up the latest ingestion configuration.

## Details
### Overview

Saving ingestion settings affects future ingestion. Reprocessing applies those settings to documents that have already been indexed.

### Operational Behavior

Until reprocessing runs, previously indexed documents continue using their existing chunk layout and embeddings.

### When To Use It

Use reprocessing after meaningful ingestion changes, especially after changing chunking strategy, chunk size, overlap, or semantic chunk limits.
