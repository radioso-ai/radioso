-- Explicit consent before a sensitive routine slot (#1544).
--
-- routine_definition.consents holds the consents an author writes on a routine: each names the
-- sensitive slots it covers, its wording per language, and what the routine does on decline. A
-- consent is always read and written whole with its routine and nothing queries its fields, so it
-- is one JSONB array beside the routine rather than child tables. Every existing routine reads back
-- with none, so no routine changes behaviour.
--
-- routine_consent_wording_versions keeps every wording a visitor was shown, immutably: one language
-- variant of a consent, identified by a hash of its content. Rows are only ever inserted, never
-- changed, so a record can always reproduce the exact text the visitor saw.
--
-- routine_consent_records keeps each decision: who decided (conversation and visitor, as plain
-- ids), which consent and wording, how (a button or a written reply), on which channel, and when,
-- with an optional withdrawal. It holds no reply text and no slot values. The proof outlives its
-- conversation and visitor (Art. 17(3)(e)), so conversation_id and visitor_id carry no foreign key;
-- only the link to the message that carried the decision is dropped when that message goes. Records
-- and versions go with their workspace. A record is kept while its conversation exists, then follows
-- the workspace's own retention window; a version goes once no record names it.
--
-- Locks. ADD COLUMN with a constant default is a catalog-only change in PostgreSQL 11+, and the
-- CHECK is validated against existing rows (all '[]'); both hold ACCESS EXCLUSIVE on
-- routine_definition for milliseconds, and only routine reads and writes wait. The new tables'
-- foreign keys then take SHARE ROW EXCLUSIVE on workspaces, agents and messages for the instant
-- each is created. Each wait is bounded to three seconds; a deploy that hits it rolls back whole
-- and a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE routine_definition
  ADD COLUMN IF NOT EXISTS consents JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE routine_definition
  DROP CONSTRAINT IF EXISTS routine_definition_consents_array_check;

ALTER TABLE routine_definition
  ADD CONSTRAINT routine_definition_consents_array_check CHECK (jsonb_typeof(consents) = 'array');

CREATE TABLE routine_consent_wording_versions (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  locale TEXT NOT NULL,
  body TEXT NOT NULL,
  agree_label TEXT NOT NULL,
  decline_label TEXT NOT NULL,
  first_shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id)
);

-- Retention: versions past the workspace's window that no record names.
CREATE INDEX routine_consent_wording_versions_retention_idx
  ON routine_consent_wording_versions (workspace_id, first_shown_at);

CREATE TABLE routine_consent_records (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id UUID,
  visitor_id UUID,
  routine_id TEXT NOT NULL,
  consent_key TEXT NOT NULL,
  slot_keys TEXT[] NOT NULL,
  wording_version_id TEXT NOT NULL,
  locale TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('granted', 'declined')),
  method TEXT NOT NULL CHECK (method IN ('button', 'reply')),
  defaulted BOOLEAN NOT NULL DEFAULT false,
  channel TEXT,
  decision_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ,
  withdrawn_by_account_id UUID,
  withdrawn_by_user_id UUID,
  FOREIGN KEY (workspace_id, wording_version_id) REFERENCES routine_consent_wording_versions (workspace_id, id),
  CHECK (withdrawn_at IS NULL OR decision = 'granted')
);

-- One decision per conversation, routine, consent and wording, so a retried turn records it once.
CREATE UNIQUE INDEX routine_consent_records_decision_key
  ON routine_consent_records (conversation_id, routine_id, consent_key, wording_version_id);

-- Retention: records past the workspace's window.
CREATE INDEX routine_consent_records_retention_idx
  ON routine_consent_records (workspace_id, decided_at);

-- Wording retention looks for a record that still names a version, and removing a version checks
-- the foreign key the same way.
CREATE INDEX routine_consent_records_wording_idx
  ON routine_consent_records (workspace_id, wording_version_id);

-- Deleting an agent sets agent_id to null on its records; this keeps that from scanning the table.
CREATE INDEX routine_consent_records_agent_idx
  ON routine_consent_records (agent_id)
  WHERE agent_id IS NOT NULL;

-- Export: a data subject's records by visitor.
CREATE INDEX routine_consent_records_visitor_idx
  ON routine_consent_records (workspace_id, visitor_id)
  WHERE visitor_id IS NOT NULL;

-- Erasure deletes messages by cascade; this keeps the SET NULL on decision_message_id from
-- scanning the table.
CREATE INDEX routine_consent_records_message_idx
  ON routine_consent_records (decision_message_id)
  WHERE decision_message_id IS NOT NULL;
