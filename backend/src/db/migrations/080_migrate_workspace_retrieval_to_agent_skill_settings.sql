DO $$
DECLARE
  offending_workspace_ids TEXT;
BEGIN
  SELECT string_agg(rs.workspace_id::text, ', ' ORDER BY rs.workspace_id::text)
  INTO offending_workspace_ids
  FROM retrieval_settings rs
  WHERE rs.similarity_threshold IS DISTINCT FROM 0.2
    AND EXISTS (
      SELECT 1
      FROM agents a
      WHERE a.workspace_id = rs.workspace_id
    );

  IF offending_workspace_ids IS NOT NULL THEN
    RAISE EXCEPTION
      '071 US4 migration aborted: workspaces with non-default similarity_threshold cannot be migrated per-agent: %',
      offending_workspace_ids;
  END IF;
END $$;

WITH migration_defaults AS (
  SELECT
    -- These literals mirror backend/prompts/retrieval/*-rewrite-instructions.md at migration time.
    $rw$Rewrite for semantic retrieval with the same meaning. Keep the query standalone, preserve proper nouns and technical terms, and avoid adding new topics.
$rw$::text AS semantic_raw,
    $rw$Rewrite for semantic retrieval with the same meaning. Keep the query standalone, preserve proper nouns and technical terms, and avoid adding new topics.$rw$::text AS semantic_collapsed,
    $rw$Rewrite the user query for lexical/BM25 retrieval. Preserve exact entity names, identifiers, filenames, and wording likely to appear in the corpus. Remove conversational filler and produce a concise keyword-style query. Prefer precise literals over semantic paraphrasing. When the query resolves to a concrete subject, make the lexical query the subject itself rather than the surrounding request/action wording. Add only a few high-confidence related terms when useful. Avoid broad OR expansions.

Examples:
where can I find tangerines in Beijing?
→ tangerines Beijing

Who is Paramhansa Yogananda and Dr. Lewis?
→ "Paramhansa Yogananda" "Dr. Lewis"

Why does requirePermission.ts bypass workspace permissions?
→ requirePermission.ts workspace permission bypass
$rw$::text AS lexical_raw,
    $rw$Rewrite the user query for lexical/BM25 retrieval. Preserve exact entity names, identifiers, filenames, and wording likely to appear in the corpus. Remove conversational filler and produce a concise keyword-style query. Prefer precise literals over semantic paraphrasing. When the query resolves to a concrete subject, make the lexical query the subject itself rather than the surrounding request/action wording. Add only a few high-confidence related terms when useful. Avoid broad OR expansions. Examples: where can I find tangerines in Beijing? → tangerines Beijing Who is Paramhansa Yogananda and Dr. Lewis? → "Paramhansa Yogananda" "Dr. Lewis" Why does requirePermission.ts bypass workspace permissions? → requirePermission.ts workspace permission bypass$rw$::text AS lexical_collapsed
),
agent_workspace_settings AS (
  SELECT
    a.id,
    CASE
      WHEN jsonb_typeof(COALESCE(a.skill_settings, '{}'::jsonb)) = 'object'
      THEN COALESCE(a.skill_settings, '{}'::jsonb)
      ELSE '{}'::jsonb
    END AS skill_settings,
    CASE
      WHEN jsonb_typeof(a.skill_settings -> 'retrieval.answer') = 'object'
      THEN a.skill_settings -> 'retrieval.answer'
      ELSE '{}'::jsonb
    END AS existing_obj,
    rs.query_rewrite_enabled,
    rs.rerank_enabled,
    rs.vector_top_k,
    rs.rerank_top_k,
    rs.custom_instruction,
    COALESCE(rs.attribute_controls, '{}'::jsonb) AS attribute_controls,
    rs.attribute_controls ->> 'retrievalStrategy' AS retrieval_strategy,
    rs.attribute_controls ->> 'suggestedQuestionsEnabled' AS suggested_questions_enabled,
    rs.attribute_controls ->> 'suggestedQuestionsCount' AS suggested_questions_count,
    CASE
      WHEN jsonb_typeof(rs.attribute_controls -> 'metadataRules') = 'array'
      THEN rs.attribute_controls -> 'metadataRules'
      ELSE '[]'::jsonb
    END AS metadata_rules,
    rs.attribute_controls ->> 'semanticRewriteInstructions' AS semantic_rewrite_instructions,
    rs.attribute_controls ->> 'lexicalRewriteInstructions' AS lexical_rewrite_instructions,
    migration_defaults.semantic_raw,
    migration_defaults.semantic_collapsed,
    migration_defaults.lexical_raw,
    migration_defaults.lexical_collapsed
  FROM agents a
  JOIN retrieval_settings rs ON rs.workspace_id = a.workspace_id
  CROSS JOIN migration_defaults
),
agent_additions AS (
  SELECT
    id,
    skill_settings,
    existing_obj,
    (
      CASE
        WHEN query_rewrite_enabled = true
          AND NOT (existing_obj ? 'queryRewriteEnabled')
        THEN jsonb_build_object('queryRewriteEnabled', query_rewrite_enabled)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN rerank_enabled = true
          AND NOT (existing_obj ? 'rerankEnabled')
        THEN jsonb_build_object('rerankEnabled', rerank_enabled)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN vector_top_k <> 15
          AND NOT (existing_obj ? 'vectorTopK')
        THEN jsonb_build_object('vectorTopK', vector_top_k)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN rerank_top_k <> 5
          AND NOT (existing_obj ? 'rerankTopK')
        THEN jsonb_build_object('rerankTopK', rerank_top_k)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN COALESCE(NULLIF(btrim(custom_instruction), ''), NULL) IS NOT NULL
          AND NOT (existing_obj ? 'customInstruction')
        THEN jsonb_build_object('customInstruction', custom_instruction)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN attribute_controls ? 'retrievalStrategy'
          AND retrieval_strategy <> 'fixed'
          AND NOT (existing_obj ? 'retrievalStrategy')
        THEN jsonb_build_object('retrievalStrategy', retrieval_strategy)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN COALESCE(suggested_questions_enabled::boolean, true) = false
          AND NOT (existing_obj ? 'suggestedQuestionsEnabled')
        THEN jsonb_build_object('suggestedQuestionsEnabled', suggested_questions_enabled::boolean)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN COALESCE(suggested_questions_count::integer, 3) <> 3
          AND NOT (existing_obj ? 'suggestedQuestionsCount')
        THEN jsonb_build_object('suggestedQuestionsCount', suggested_questions_count::integer)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN jsonb_array_length(metadata_rules) > 0
          AND NOT (existing_obj ? 'metadataRules')
        THEN jsonb_build_object('metadataRules', metadata_rules)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN semantic_rewrite_instructions IS NOT NULL
          AND NULLIF(btrim(semantic_rewrite_instructions), '') IS NOT NULL
          AND semantic_rewrite_instructions <> semantic_raw
          AND semantic_rewrite_instructions <> semantic_collapsed
          AND NOT (existing_obj ? 'semanticRewriteInstructions')
        THEN jsonb_build_object('semanticRewriteInstructions', semantic_rewrite_instructions)
        ELSE '{}'::jsonb
      END ||
      CASE
        WHEN lexical_rewrite_instructions IS NOT NULL
          AND NULLIF(btrim(lexical_rewrite_instructions), '') IS NOT NULL
          AND lexical_rewrite_instructions <> lexical_raw
          AND lexical_rewrite_instructions <> lexical_collapsed
          AND NOT (existing_obj ? 'lexicalRewriteInstructions')
        THEN jsonb_build_object('lexicalRewriteInstructions', lexical_rewrite_instructions)
        ELSE '{}'::jsonb
      END
    ) AS add
  FROM agent_workspace_settings
)
UPDATE agents a
SET skill_settings = jsonb_set(
    agent_additions.skill_settings,
    '{retrieval.answer}',
    agent_additions.existing_obj || agent_additions.add,
    true
  ),
  updated_at = NOW()
FROM agent_additions
WHERE a.id = agent_additions.id
  AND agent_additions.add <> '{}'::jsonb;
