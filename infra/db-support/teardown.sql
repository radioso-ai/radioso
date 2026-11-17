-- Run by `db-support.sh teardown <stack>` before Terraform turns `db_support_access_enabled` off.
-- pgaudit's event triggers load its library on every schema change, which fails once the flag no
-- longer preloads it, so the extension and the settings that name it go first. The
-- radioso_support group role stays; it holds grants and no login.

ALTER DATABASE radioso RESET pgaudit.log;
ALTER ROLE radioso RESET pgaudit.log;
DROP EXTENSION IF EXISTS pgaudit;
REVOKE radioso_support FROM :"support_user";

SELECT count(*) AS pgaudit_installed FROM pg_extension WHERE extname = 'pgaudit';
