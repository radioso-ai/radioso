-- Operator state on Audience Pulse topics. The report snapshot is overwritten on every refresh, so
-- what an operator decides about a topic lives here and is read beside the report. A topic keeps
-- its id across census runs while it survives, so the state follows it from one refresh to the
-- next. Each row goes with its workspace, its topic and, for a draft, its document.

-- A topic the operator marked "not for us": out of the "Content to write" queue. No count changes.
CREATE TABLE audience_pulse_topic_dismissals (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic_id UUID NOT NULL,
  dismissed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, topic_id),
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) ON DELETE CASCADE
);

-- A document drafted from a topic. Deleting the document deletes the link.
CREATE TABLE audience_pulse_topic_drafts (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic_id UUID NOT NULL,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, topic_id, document_id),
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) ON DELETE CASCADE
);

-- Deleting a document finds its links without scanning the table.
CREATE INDEX audience_pulse_topic_drafts_document_idx ON audience_pulse_topic_drafts (document_id);

-- Deleting a user clears the actor columns without scanning either table.
CREATE INDEX audience_pulse_topic_dismissals_user_idx
  ON audience_pulse_topic_dismissals (dismissed_by_user_id)
  WHERE dismissed_by_user_id IS NOT NULL;
CREATE INDEX audience_pulse_topic_drafts_user_idx
  ON audience_pulse_topic_drafts (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
