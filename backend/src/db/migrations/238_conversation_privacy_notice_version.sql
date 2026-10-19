-- The privacy notice a conversation's visitor was shown before their first message (#1545): the
-- `version` of the agent's `branding.privacyNotice` entry, `<language tag>:<16 hex>`, derived from the
-- notice's language, line and link. A notice, not consent. Null when no notice was shown or the
-- reported version is not one the agent's notices carried.
--
-- Written once: by the turn that creates a chat or voice conversation, from the version its client
-- reports, and by the commitment of an email conversation's first reply, which carries the notice.
-- The column is on the conversation row, so the conversation's erasure removes it.
--
-- A nullable column with no default is a catalog change: no rewrite, no scan, no index. The lock
-- wait is bounded to three seconds; a deploy that hits it rolls back whole and a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS privacy_notice_version TEXT;
