-- One mutable draft and immutable release candidates for each agent. The snapshot
-- remains opaque to persistence: resource owners validate/project it before write.
CREATE TABLE agent_drafts (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  base_published_revision_id UUID,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_revisions (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_format_version INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_format_version > 0),
  snapshot JSONB NOT NULL,
  source_draft_generation INTEGER NOT NULL CHECK (source_draft_generation > 0),
  source_base_published_revision_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX idx_agent_revisions_agent_created ON agent_revisions(agent_id, created_at DESC);

CREATE TABLE agent_publications (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES agent_revisions(id) ON DELETE RESTRICT,
  previous_revision_id UUID REFERENCES agent_revisions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  expected_draft_generation INTEGER NOT NULL CHECK (expected_draft_generation > 0),
  expected_published_revision_id UUID REFERENCES agent_revisions(id) ON DELETE RESTRICT,
  actor_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX idx_agent_publications_agent_created ON agent_publications(agent_id, created_at DESC);

ALTER TABLE agents ADD COLUMN published_revision_id UUID REFERENCES agent_revisions(id) ON DELETE RESTRICT;
CREATE INDEX idx_agents_published_revision ON agents(published_revision_id) WHERE published_revision_id IS NOT NULL;

-- Conversation history outlives a deleted agent. The revision pin belongs to that
-- agent's cascading revision history, so clear it with conversations.agent_id.
ALTER TABLE conversations ADD COLUMN agent_revision_id UUID REFERENCES agent_revisions(id) ON DELETE SET NULL;
CREATE INDEX idx_conversations_agent_revision ON conversations(agent_revision_id) WHERE agent_revision_id IS NOT NULL;

-- Only unsafe legacy routine pins need durable operator follow-up. Safe pins are
-- captured in their agent revision below; unsafe conversations remain unbound.
-- An unbound conversation that receives another turn fails closed with a
-- conversation_revision_unavailable AppError (see chatSessionPreparer.ts),
-- logged with the conversationId; join that id against this table's
-- conversation_id to see why it was left unbound (an ambiguous/missing/invalid
-- routine pin here, or a NULL agent_id at migration time, which this table
-- does not record). No operator-facing surface reads this table yet.
CREATE TABLE agent_revision_migration_classifications (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  routine_id TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('missing_routine_definition', 'ambiguous_routine_definition', 'invalid_routine_pin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_revision_migration_classifications_agent ON agent_revision_migration_classifications(agent_id, created_at DESC);

-- Cutover baseline: preserve the complete scoped live configuration for every
-- pre-existing agent. New/imported agents are initialized by the authoring flow
-- and remain unpublished until an explicit release.
WITH routine_json AS (
  SELECT r.id, r.agent_id, r.lineage_id, r.version, r.status, r.activation_priority, r.created_at,
    jsonb_build_object(
      'id', r.id, 'agentId', r.agent_id, 'lineageId', r.lineage_id, 'version', r.version, 'status', r.status, 'name', r.name,
      'activation', jsonb_build_object('triggerDescription', r.activation_trigger_description, 'gateRef', r.activation_gate_ref, 'priority', r.activation_priority, 'reentryMode', r.activation_reentry_mode),
      'slots', coalesce((SELECT jsonb_agg(jsonb_build_object('stableSlotId', s.stable_slot_id, 'key', s.key, 'type', s.type, 'required', s.required, 'description', s.description, 'mutable', s.mutable, 'ordinal', s.ordinal) ORDER BY s.ordinal) FROM routine_slot s WHERE s.definition_id = r.id), '[]'::jsonb),
      'steps', coalesce((SELECT jsonb_agg(
        jsonb_build_object('stableStepId', s.stable_step_id, 'kind', s.kind, 'instruction', s.instruction, 'toolRef', s.tool_ref, 'actionType', s.action_type, 'ordinal', s.ordinal, 'metadata', s.metadata)
        || CASE WHEN s.capture_key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('captureKey', s.capture_key) END
        || CASE WHEN s.options IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('options', s.options) END
        ORDER BY s.ordinal
      ) FROM routine_step s WHERE s.definition_id = r.id), '[]'::jsonb),
      'transitions', coalesce((SELECT jsonb_agg(jsonb_build_object('fromStep', t.from_step, 'toRef', t.to_ref, 'guardKind', t.guard_kind, 'guardText', t.guard_text, 'outcomeStatus', t.outcome_status, 'counterLimit', t.counter_limit, 'fieldRef', t.field_ref, 'fieldOp', t.field_op, 'fieldValue', t.field_value, 'fieldValues', t.field_values, 'fieldUnit', t.field_unit, 'ordinal', t.ordinal) ORDER BY t.ordinal) FROM routine_transition t WHERE t.definition_id = r.id), '[]'::jsonb),
      'terminals', coalesce((SELECT jsonb_agg(jsonb_build_object('stableStepId', t.stable_step_id, 'kind', t.kind, 'instruction', t.instruction, 'ordinal', t.ordinal) ORDER BY t.ordinal) FROM routine_terminal t WHERE t.definition_id = r.id), '[]'::jsonb),
      'completionExport', coalesce((SELECT jsonb_build_object('enabled', e.enabled, 'triggerKinds', e.trigger_kinds, 'destinationRef', e.destination_ref) FROM routine_completion_export e WHERE e.definition_id = r.id), jsonb_build_object('enabled', false, 'triggerKinds', '[]'::jsonb, 'destinationRef', '')),
      'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) AS routine
  FROM routine_definition r
), selected_draft_routine_rank AS (
  SELECT routine_json.*, row_number() OVER (
    PARTITION BY agent_id, lineage_id
    ORDER BY CASE WHEN status = 'draft' THEN 0 ELSE 1 END, version DESC
  ) AS selection_rank
  FROM routine_json
  WHERE status IN ('draft', 'published')
), selected_draft_routines AS (
  SELECT * FROM selected_draft_routine_rank WHERE selection_rank = 1
), directive_json AS (
  SELECT d.id, d.agent_id, d.created_at,
    jsonb_build_object(
      'id', d.id, 'agentId', d.agent_id, 'name', d.name,
      'condition', CASE WHEN d.condition_kind = 'contextual' THEN jsonb_build_object('kind', 'contextual', 'description', d.condition_description) ELSE jsonb_build_object('kind', 'always') END,
      'action', d.action, 'priority', d.priority, 'requiredCapabilities', d.required_capabilities,
      'dependsOn', d.depends_on, 'excludes', d.excludes, 'routes', d.routes, 'surfaces', d.surfaces,
      'tags', d.scope_tags, 'description', d.description, 'binding', d.binding, 'lifecycle', d.lifecycle,
      'enabled', d.enabled, 'metadata', d.metadata, 'createdAt', d.created_at, 'updatedAt', d.updated_at
    ) AS directive
  FROM agent_directives d
), draft_directive_tags AS (
  SELECT d.id,
    to_jsonb(coalesce(array_agg(
      CASE
        WHEN scoped.tag ~ '^routine:[0-9A-Fa-f-]{36}$'
          AND source.id IS NOT NULL AND target.id IS NOT NULL AND target.id <> source.id
          THEN 'routine:' || target.id
        WHEN scoped.tag ~ '^step:[0-9A-Fa-f-]{36}:.+$'
          AND source.id IS NOT NULL AND target.id IS NOT NULL AND target.id <> source.id
          AND EXISTS (SELECT 1 FROM routine_step target_step WHERE target_step.definition_id = target.id AND target_step.stable_step_id = substring(scoped.tag FROM '^step:[0-9A-Fa-f-]{36}:(.+)$'))
          THEN 'step:' || target.id || ':' || substring(scoped.tag FROM '^step:[0-9A-Fa-f-]{36}:(.+)$')
        ELSE scoped.tag
      END ORDER BY scoped.ordinal
    ) FILTER (WHERE scoped.tag IS NOT NULL), ARRAY[]::text[])) AS tags
  FROM agent_directives d
  LEFT JOIN LATERAL unnest(d.scope_tags) WITH ORDINALITY AS scoped(tag, ordinal) ON TRUE
  LEFT JOIN LATERAL (
    SELECT source.*
    FROM routine_definition source
    WHERE source.agent_id = d.agent_id
      AND source.id = CASE
        WHEN scoped.tag ~ '^routine:[0-9A-Fa-f-]{36}$' THEN substring(scoped.tag FROM '^routine:([0-9A-Fa-f-]{36})$')::uuid
        WHEN scoped.tag ~ '^step:[0-9A-Fa-f-]{36}:.+$' THEN substring(scoped.tag FROM '^step:([0-9A-Fa-f-]{36}):.+$')::uuid
      END
  ) source ON TRUE
  LEFT JOIN selected_draft_routines target ON target.agent_id = d.agent_id AND target.lineage_id = source.lineage_id
  GROUP BY d.id
), draft_directives AS (
  SELECT directive_json.agent_id, directive_json.created_at, directive_json.id,
    jsonb_set(directive_json.directive, '{tags}', draft_directive_tags.tags) AS directive
  FROM directive_json
  JOIN draft_directive_tags ON draft_directive_tags.id = directive_json.id
), retained_routines AS (
  SELECT DISTINCT routine_json.*
  FROM routine_json
  JOIN conversations conversation ON conversation.agent_id = routine_json.agent_id
  JOIN routine_states state ON state.session_id = conversation.id
    AND state.status IN ('active', 'suspended')
    AND (state.expires_at IS NULL OR state.expires_at > now())
  WHERE routine_json.status IN ('superseded', 'archived')
    AND 1 = (
      SELECT count(*)
      FROM routine_definition candidate
      WHERE candidate.agent_id = conversation.agent_id
        AND candidate.status <> 'draft'
        AND (candidate.id::text = state.routine_id OR ('routine:' || candidate.agent_id || ':' || candidate.name || ':v' || candidate.version) = state.routine_id)
    )
    AND (routine_json.id::text = state.routine_id OR ('routine:' || routine_json.agent_id || ':' || (routine_json.routine ->> 'name') || ':v' || routine_json.version) = state.routine_id)
), snapshots AS (
  SELECT a.id AS agent_id, a.workspace_id,
    jsonb_build_object(
      'customInstruction', coalesce(a.behavior_settings ->> 'customInstruction', ''),
      'directives', coalesce((SELECT jsonb_agg(directive ORDER BY created_at, id) FROM directive_json WHERE agent_id = a.id), '[]'::jsonb),
      'routines', coalesce((SELECT jsonb_agg(routine ORDER BY created_at, id) FROM routine_json WHERE agent_id = a.id AND status = 'published'), '[]'::jsonb),
      'retainedRoutineDefinitions', coalesce((SELECT jsonb_agg(routine ORDER BY created_at, id) FROM retained_routines WHERE agent_id = a.id), '[]'::jsonb),
      'contextVariableEnablements', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', cv.id, 'agentId', cv.agent_id, 'variableId', cv.variable_id, 'source', cv.source,
        'resolverSkillId', cv.resolver_skill_id, 'maxAgeSeconds', cv.max_age_seconds, 'resolverTimeoutMs', cv.resolver_timeout_ms,
        'surfacing', cv.surfacing, 'enabled', cv.enabled, 'createdAt', cv.created_at, 'updatedAt', cv.updated_at
      ) ORDER BY cv.created_at, cv.id) FROM agent_context_variables cv WHERE cv.agent_id = a.id), '[]'::jsonb)
    ) AS snapshot
  FROM agents a
), draft_snapshots AS (
  SELECT snapshots.agent_id, snapshots.workspace_id,
    jsonb_set(
      jsonb_set(
        jsonb_set(snapshots.snapshot, '{routines}', coalesce((SELECT jsonb_agg(routine ORDER BY activation_priority DESC, created_at, id) FROM selected_draft_routines WHERE agent_id = snapshots.agent_id), '[]'::jsonb)),
        '{directives}', coalesce((SELECT jsonb_agg(directive ORDER BY created_at, id) FROM draft_directives WHERE agent_id = snapshots.agent_id), '[]'::jsonb)
      ),
      '{retainedRoutineDefinitions}', '[]'::jsonb
    ) AS snapshot
  FROM snapshots
), revisions AS (
  INSERT INTO agent_revisions (id, agent_id, workspace_id, snapshot, source_draft_generation, source_base_published_revision_id, published_at)
  SELECT gen_random_uuid(), agent_id, workspace_id, snapshot, 1, NULL, now() FROM snapshots
  RETURNING id, agent_id, workspace_id, snapshot
), pointers AS (
  UPDATE agents a SET published_revision_id = r.id FROM revisions r WHERE a.id = r.agent_id
)
INSERT INTO agent_drafts (agent_id, workspace_id, generation, base_published_revision_id, snapshot)
SELECT draft_snapshots.agent_id, draft_snapshots.workspace_id, 1, revisions.id, draft_snapshots.snapshot
FROM draft_snapshots
JOIN revisions ON revisions.agent_id = draft_snapshots.agent_id;

-- A legacy conversation is attributable only when both its workspace and agent
-- resolve to the baseline pointer created above. Leave every other row unbound:
-- revision-aware readers must fail closed rather than infer an agent from history.
WITH unsafe_active_pins AS (
  SELECT conversation.id AS conversation_id, conversation.agent_id, conversation.workspace_id, state.routine_id,
    CASE
      WHEN count(candidate.id) > 1 THEN 'ambiguous_routine_definition'
      WHEN state.routine_id ~ '^[0-9A-Fa-f-]{36}$' OR state.routine_id ~ '^routine:[0-9A-Fa-f-]{36}:.+:v[0-9]+$' THEN 'missing_routine_definition'
      ELSE 'invalid_routine_pin'
    END AS classification
  FROM conversations conversation
  JOIN routine_states state ON state.session_id = conversation.id
    AND state.status IN ('active', 'suspended')
    AND (state.expires_at IS NULL OR state.expires_at > now())
  LEFT JOIN routine_definition candidate ON candidate.agent_id = conversation.agent_id
    AND candidate.status <> 'draft'
    AND (candidate.id::text = state.routine_id OR ('routine:' || candidate.agent_id || ':' || candidate.name || ':v' || candidate.version) = state.routine_id)
  WHERE conversation.agent_id IS NOT NULL
  GROUP BY conversation.id, conversation.agent_id, conversation.workspace_id, state.routine_id
  HAVING count(candidate.id) <> 1
)
INSERT INTO agent_revision_migration_classifications (conversation_id, agent_id, workspace_id, routine_id, classification)
SELECT conversation_id, agent_id, workspace_id, routine_id, classification FROM unsafe_active_pins;

UPDATE conversations AS conversation
SET agent_revision_id = agent.published_revision_id
FROM agents AS agent
WHERE conversation.agent_revision_id IS NULL
  AND conversation.workspace_id = agent.workspace_id
  AND conversation.agent_id = agent.id
  AND agent.published_revision_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM agent_revision_migration_classifications classification WHERE classification.conversation_id = conversation.id);
