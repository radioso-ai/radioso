-- Lexical retrieval builds its tsvector from search_text only, so that the
-- expression matches chunks_search_text_fts_idx and the GIN index is usable.
-- The query previously fell back to content when search_text was NULL, which made
-- the expression differ from the index and forced a sequential scan over every
-- chunk partition on every lexical search.
--
-- Every current writer stores `searchText ?? content`, so search_text is already
-- non-null for anything ingested by this code. This backfills rows that predate
-- that behavior, keeping the fallback's effect while dropping it from the query.
--
-- Cost note: search_text has no index on its nullness, so this is one full pass over
-- the chunk partitions at startup. It is a one-time backfill and rewrites only the
-- rows it finds, but a self-hosted deployment with a very large corpus should expect
-- this migration to take longer than its neighbours.

UPDATE chunks
SET search_text = content
WHERE search_text IS NULL;
