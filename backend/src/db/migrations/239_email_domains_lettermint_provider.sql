-- Lettermint becomes a selectable email-channel provider beside Resend: email_domains.provider
-- widens to admit it. The CHECK is a plain column constraint (226's pattern): drop and recreate
-- it naming every accepted provider.
--
-- Locks. DROP/ADD CONSTRAINT takes ACCESS EXCLUSIVE on email_domains for the catalog change only.
-- The migration runner disables lock timeouts for a migration's body, so this sets its own: a
-- transaction still reading or writing the table makes the deploy fail after three seconds, and
-- the rollback leaves nothing behind, instead of queueing every domain read and write behind it.
-- A retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE email_domains
  DROP CONSTRAINT email_domains_provider_check;

ALTER TABLE email_domains
  ADD CONSTRAINT email_domains_provider_check
  CHECK (provider IN ('resend', 'lettermint', 'local'));
