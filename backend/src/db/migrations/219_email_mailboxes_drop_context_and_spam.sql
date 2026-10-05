-- Drops two mailbox settings the email channel does not read: the review turn's history window is a
-- fixed constant of the review runner, and spam-flagged mail is always a bounded event-log record.
--
-- Locks. DROP COLUMN takes ACCESS EXCLUSIVE on email_mailboxes for the catalog change only (no table
-- rewrite), bounded to a three-second wait.
SET LOCAL lock_timeout = '3s';

ALTER TABLE email_mailboxes
  DROP COLUMN IF EXISTS thread_context_messages,
  DROP COLUMN IF EXISTS spam_opt_in;
