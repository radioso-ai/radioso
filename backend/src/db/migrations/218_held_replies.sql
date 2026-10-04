-- Held replies: a reply an agent produced in review that waits for a teammate before it reaches the
-- customer. Channel-neutral and owned by handoff. The producing channel binds it to an opaque policy
-- (`policy_ref`, e.g. `email_mailbox:<uuid>`, at `policy_version`), the conversation's ownership
-- version, the customer message it answers and an idempotency ref (`review_ref`); handoff interprets
-- none of them beyond comparing versions.
--
--   pending      waiting for a teammate to release, edit and release, or discard it
--   queued_auto  queued for an automatic send, not yet authorized; never in operator attention
--   released     sent as the agent's message (`release_kind` operator, or auto once materialized)
--   edited       a teammate's edit sent as their message; the draft is kept beside the edit
--   discarded    a teammate set it aside; attention stays open until they reply or take over
--   superseded   a newer inbound, an operator reply, a takeover or a policy change replaced it
--
-- The draft (`draft_text`, `draft_presentation`) and an edit (`edited_text`) are customer content:
-- never logged, and never copied into `messages` except by an authorized release or materialization.
--
-- Send intents name the held reply they deliver; 216 left that link for this migration, which
-- creates its target.
--
-- Locks. The foreign keys take SHARE ROW EXCLUSIVE on conversations and messages until this commits,
-- and linking send intents takes it on email_send_intents while it checks the intents, all of whose
-- held_reply_id are still null: reads continue, writes to those tables wait. The migration takes
-- milliseconds, and it waits at most three seconds for those locks, as 209 does.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS held_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- The author: the agent whose review turn produced the draft.
  agent_id UUID,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'queued_auto', 'released', 'edited', 'discarded', 'superseded')),
  release_kind TEXT CHECK (release_kind IN ('operator', 'auto')),
  -- The producer's idempotency ref for the review that produced it, e.g. `email:<conversationId>:<revision>`.
  review_ref TEXT,
  -- The customer message the draft answers: the inbound revision it is bound to, and the turn's
  -- request message.
  answers_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- The conversation's ownership version the review ran at; 0 when it had no ownership row.
  ownership_version INTEGER NOT NULL CHECK (ownership_version >= 0),
  policy_ref TEXT,
  policy_version INTEGER,
  -- The producer's code for why it was held; handoff never interprets it.
  hold_reason TEXT NOT NULL,
  -- The review turn's outcome, grounding, coverage and hand-off signal, as enum codes.
  turn_facts JSONB NOT NULL,
  -- The skill effects the review suppressed: `[{ "skillName": ... }]`.
  suppressed_effects JSONB NOT NULL DEFAULT '[]'::jsonb,
  draft_text TEXT NOT NULL,
  -- Host-owned presentation of the draft, written verbatim as the agent's message on release.
  draft_presentation JSONB NOT NULL,
  edited_text TEXT,
  -- The editor, the releaser and the teammate who discarded it, each recorded on their own.
  editor_user_id UUID,
  releaser_user_id UUID,
  discarded_by_user_id UUID,
  released_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  superseded_reason TEXT
    CHECK (superseded_reason IN ('newer_inbound', 'operator_reply', 'takeover', 'policy_changed')),
  attention_cleared_at TIMESTAMPTZ,
  attention_cleared_reason TEXT
    CHECK (attention_cleared_reason IN ('released', 'operator_reply', 'takeover', 'superseded')),
  decided_at TIMESTAMPTZ,
  -- To the millisecond, so the attention list's cursor carries it exactly through a JavaScript Date,
  -- and held replies created in one transaction tie on it and order by id.
  created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A policy is bound by its ref and version together, or not at all.
  CONSTRAINT held_replies_policy_check CHECK ((policy_ref IS NULL) = (policy_version IS NULL)),
  -- Only a sent held reply has a release kind; an edit is always a teammate's, and names its editor.
  CONSTRAINT held_replies_release_check CHECK (
    (state IN ('released', 'edited')) = (release_kind IS NOT NULL)
    AND (state <> 'edited' OR (release_kind = 'operator' AND edited_text IS NOT NULL AND editor_user_id IS NOT NULL))
    AND (release_kind IS DISTINCT FROM 'operator' OR releaser_user_id IS NOT NULL)
  ),
  CONSTRAINT held_replies_discard_check CHECK (state <> 'discarded' OR discarded_by_user_id IS NOT NULL),
  CONSTRAINT held_replies_superseded_check CHECK ((state = 'superseded') = (superseded_reason IS NOT NULL)),
  -- A live draft is undecided; every other held reply was decided.
  CONSTRAINT held_replies_decided_check CHECK ((state IN ('pending', 'queued_auto')) = (decided_at IS NULL)),
  -- Attention is open on a live draft, cleared on a sent or superseded one, and on a discarded one
  -- open until a teammate replies or takes over; a cleared one says why.
  CONSTRAINT held_replies_attention_check CHECK (
    (attention_cleared_at IS NULL) = (attention_cleared_reason IS NULL)
    AND (state NOT IN ('pending', 'queued_auto') OR attention_cleared_at IS NULL)
    AND (state NOT IN ('released', 'edited', 'superseded') OR attention_cleared_at IS NOT NULL)
  )
);

-- One live draft per conversation: the operator sees one current draft.
CREATE UNIQUE INDEX IF NOT EXISTS held_replies_live_conversation_uniq
  ON held_replies (conversation_id)
  WHERE state IN ('pending', 'queued_auto');

-- One held reply per review: holding a review's result again finds the first.
CREATE UNIQUE INDEX IF NOT EXISTS held_replies_review_ref_uniq
  ON held_replies (conversation_id, review_ref)
  WHERE review_ref IS NOT NULL;

-- The Inbox and Ray: a workspace's held replies waiting for a teammate, newest first.
CREATE INDEX IF NOT EXISTS held_replies_workspace_attention_idx
  ON held_replies (workspace_id, created_at)
  WHERE attention_cleared_at IS NULL AND state <> 'queued_auto';

-- A policy change supersedes the live drafts bound to the policy.
CREATE INDEX IF NOT EXISTS held_replies_live_policy_idx
  ON held_replies (policy_ref)
  WHERE state IN ('pending', 'queued_auto');

-- A conversation's held replies, newest first: its current draft, and its discarded drafts' attention.
CREATE INDEX IF NOT EXISTS held_replies_conversation_created_idx
  ON held_replies (conversation_id, created_at);

-- Send intents name the held reply they deliver. A held reply goes only with its conversation, which
-- takes its intents with it, so the link clears rather than refusing whichever cascade runs first.
ALTER TABLE email_send_intents
  DROP CONSTRAINT IF EXISTS email_send_intents_held_reply_id_fkey;

ALTER TABLE email_send_intents
  ADD CONSTRAINT email_send_intents_held_reply_id_fkey
  FOREIGN KEY (held_reply_id) REFERENCES held_replies(id) ON DELETE SET NULL;
