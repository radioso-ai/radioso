-- Directive scope tags must reference routine definition ids: the compiled
-- routine id is now the definition UUID, so tags written against the legacy
-- compiled id (`routine:<agentId>:<name>:v<N>`) would never match at runtime.
-- Best-effort rewrite: resolve legacy-format tags to the unique definition row
-- (agent_id, name, version) — guaranteed unique by 084's UNIQUE constraint —
-- and leave unresolvable tags untouched. Re-runnable: rewritten tags no longer
-- match the legacy pattern.
DO $$
DECLARE
  directive RECORD;
  tag TEXT;
  new_tags TEXT[];
  changed BOOLEAN;
  m TEXT[];
  def_id UUID;
BEGIN
  -- search_path-aware so the migration harness can exercise this in an
  -- isolated schema; resolves to public in production.
  IF to_regclass('agent_directives') IS NULL OR to_regclass('routine_definition') IS NULL THEN
    RETURN;
  END IF;

  FOR directive IN
    SELECT d.id, d.agent_id, d.scope_tags
    FROM agent_directives d
    WHERE EXISTS (
      SELECT 1 FROM unnest(d.scope_tags) AS t
      WHERE t LIKE 'routine:routine:%' OR t LIKE 'step:routine:%'
    )
  LOOP
    new_tags := ARRAY[]::TEXT[];
    changed := FALSE;

    FOREACH tag IN ARRAY directive.scope_tags LOOP
      def_id := NULL;

      -- routine:routine:<agentUuid>:<name>:v<N>
      m := regexp_match(tag, '^routine:routine:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.*):v([0-9]+)$');
      IF m IS NOT NULL THEN
        SELECT rd.id INTO def_id
        FROM routine_definition rd
        WHERE rd.agent_id = m[1]::uuid
          AND rd.agent_id = directive.agent_id
          AND rd.name = m[2]
          AND rd.version = m[3]::int;
        IF def_id IS NOT NULL THEN
          new_tags := array_append(new_tags, 'routine:' || def_id::text);
          changed := TRUE;
          CONTINUE;
        END IF;
      END IF;

      -- step:routine:<agentUuid>:<name>:v<N>:<stepId> (step ids are colon-free slugs)
      m := regexp_match(tag, '^step:routine:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.*):v([0-9]+):([^:]+)$');
      IF m IS NOT NULL THEN
        SELECT rd.id INTO def_id
        FROM routine_definition rd
        WHERE rd.agent_id = m[1]::uuid
          AND rd.agent_id = directive.agent_id
          AND rd.name = m[2]
          AND rd.version = m[3]::int;
        IF def_id IS NOT NULL THEN
          new_tags := array_append(new_tags, 'step:' || def_id::text || ':' || m[4]);
          changed := TRUE;
          CONTINUE;
        END IF;
      END IF;

      new_tags := array_append(new_tags, tag);
    END LOOP;

    IF changed THEN
      UPDATE agent_directives
      SET scope_tags = new_tags, updated_at = NOW()
      WHERE id = directive.id;
    END IF;
  END LOOP;
END $$;
