-- Partition chunk_embeddings by hash of workspace_id, matching chunks.
--
-- Vector search walks an HNSW graph and applies the workspace filter as it goes.
-- With every workspace in one graph, a search for a workspace that owns a small
-- share of the corpus spends its walk on rows belonging to other workspaces, which
-- are then discarded — it returns fewer results than asked for. Partitioning by
-- workspace prunes the search to one partition, so a far larger share of what the
-- walk reaches is eligible.
--
-- The modulus deliberately matches chunks (16). chunk_embeddings is joined to chunks
-- on workspace_id on every search, and a partition-wise join is only available when
-- both sides share a partition key and modulus. A different modulus would forfeit
-- that permanently.
--
-- Partition count is not fixed forever: a hash partition can later be split into two
-- finer ones (detach, create MODULUS 2n halves, move that partition's rows, drop the
-- old), and moduli may coexist on one table. Only the unpartitioned-to-partitioned
-- step needs a full copy, which is why it happens here rather than later.
--
-- Cost note: this rebuilds the table inside the migration transaction, which holds
-- ACCESS EXCLUSIVE for the copy, the foreign-key validation, and the index builds,
-- and the migration runner disables statement and lock timeouts for migration
-- bodies. chunk_embeddings is empty or near-empty wherever canonical projection has
-- not been backfilled, making this effectively free there; a deployment holding many
-- canonical rows should expect writes to block for the duration and may prefer to
-- run this during a maintenance window.

ALTER TABLE chunk_embeddings RENAME TO chunk_embeddings_unpartitioned;

-- Renaming a table leaves its indexes named as they were, and index names are unique
-- per schema rather than per table, so the replacement below would collide with them.
-- IF EXISTS tolerates a deployment whose secondary indexes have drifted.
ALTER INDEX IF EXISTS chunk_embeddings_pkey RENAME TO chunk_embeddings_unpartitioned_pkey;
ALTER INDEX IF EXISTS idx_chunk_embeddings_chunk RENAME TO idx_chunk_embeddings_unpart_chunk;
ALTER INDEX IF EXISTS idx_chunk_embeddings_space RENAME TO idx_chunk_embeddings_unpart_space;

CREATE TABLE chunk_embeddings (
    workspace_id uuid NOT NULL,
    chunk_id uuid NOT NULL,
    embedding_space_id uuid NOT NULL,
    document_revision integer NOT NULL,
    canonical_version bigint NOT NULL,
    dimensions integer NOT NULL,
    embedding public.vector NOT NULL,
    content_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chunk_embeddings_canonical_version_check CHECK ((canonical_version >= 1)),
    CONSTRAINT chunk_embeddings_check CHECK ((public.vector_dims(embedding) = dimensions)),
    CONSTRAINT chunk_embeddings_dimensions_check CHECK (((dimensions >= 1) AND (dimensions <= 16000))),
    CONSTRAINT chunk_embeddings_document_revision_check CHECK ((document_revision >= 1)),
    CONSTRAINT chunk_embeddings_pkey PRIMARY KEY (workspace_id, chunk_id, embedding_space_id)
) PARTITION BY HASH (workspace_id);

DO $$
DECLARE
  remainder integer;
BEGIN
  FOR remainder IN 0..15 LOOP
    EXECUTE format(
      'CREATE TABLE chunk_embeddings_p%s PARTITION OF chunk_embeddings '
      'FOR VALUES WITH (MODULUS 16, REMAINDER %s)',
      remainder, remainder);
  END LOOP;
END $$;

INSERT INTO chunk_embeddings (
  workspace_id, chunk_id, embedding_space_id, document_revision,
  canonical_version, dimensions, embedding, content_hash, created_at, updated_at
)
SELECT
  workspace_id, chunk_id, embedding_space_id, document_revision,
  canonical_version, dimensions, embedding, content_hash, created_at, updated_at
FROM chunk_embeddings_unpartitioned;

DROP TABLE chunk_embeddings_unpartitioned;

-- Foreign keys are declared after the copy so the insert itself runs unconstrained.
-- ADD CONSTRAINT validates existing rows, so both statements scan the copied data
-- inside this transaction; that cost scales with table size like the copy above.
ALTER TABLE chunk_embeddings
  ADD CONSTRAINT chunk_embeddings_embedding_space_id_fkey
  FOREIGN KEY (embedding_space_id) REFERENCES embedding_spaces(id) ON DELETE RESTRICT;

ALTER TABLE chunk_embeddings
  ADD CONSTRAINT chunk_embeddings_workspace_id_chunk_id_fkey
  FOREIGN KEY (workspace_id, chunk_id) REFERENCES chunks(workspace_id, id) ON DELETE CASCADE;

CREATE INDEX idx_chunk_embeddings_chunk ON chunk_embeddings USING btree (workspace_id, chunk_id);
CREATE INDEX idx_chunk_embeddings_space ON chunk_embeddings USING btree (workspace_id, embedding_space_id);

-- Rebuild the per-width HNSW indexes. Replacing the table drops the indexes that
-- migration 145 created, and prepareSpace only restores them when a space next has
-- work to reconcile — a workspace that is fully projected and not ingesting would
-- otherwise sit unindexed indefinitely, which is precisely the state this change
-- exists to fix. Declared on the parent so each partition inherits its own index.
--
-- The width rule is shared with migration 145 and chunkEmbeddingVectorIndex.ts;
-- a unit test pins all of them to the same expression.
DO $$
DECLARE
  widths integer[];
  width integer;
BEGIN
  SELECT array_agg(DISTINCT dimensions ORDER BY dimensions)
    INTO widths
    FROM chunk_embeddings;

  FOREACH width IN ARRAY COALESCE(widths, ARRAY[]::integer[]) LOOP
    IF width <= 2000 THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS chunk_embeddings_hnsw_%s_idx '
        'ON chunk_embeddings USING hnsw ((embedding::vector(%s)) vector_cosine_ops) '
        'WHERE dimensions = %s',
        width, width, width);
    ELSIF width <= 4000 THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS chunk_embeddings_hnsw_%s_idx '
        'ON chunk_embeddings USING hnsw ((embedding::halfvec(%s)) halfvec_cosine_ops) '
        'WHERE dimensions = %s',
        width, width, width);
    END IF;
  END LOOP;
END $$;
