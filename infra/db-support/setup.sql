-- One-time setup for engineer database access, run as the application's own user `radioso`, which
-- owns every table, by `db-support.sh setup <stack>` after Terraform has turned on
-- `db_support_access_enabled`. Safe to run again. psql passes the db-support IAM user's name as
-- :support_user.

-- The extension needs `cloudsql.enable_pgaudit`, which Terraform sets with the switch.
CREATE EXTENSION IF NOT EXISTS pgaudit;

-- Audit every role that connects to this database. A role-level setting beats a database-level
-- one, so any login, including one added later, gets the full set without anyone remembering to
-- turn it on, while the application's own user is audited only for schema and role changes: its
-- reads and writes would flood the record, but a session with its credential that switches the
-- audit off, or grants itself a role, is still recorded. pgaudit.log can only be changed by a
-- cloudsqlsuperuser member, so the db-support user can't switch it off.
--
-- misc_set records SET statements, including the one each db-support run opens with to name the
-- run.
ALTER ROLE radioso SET pgaudit.log = 'ddl, role';
ALTER DATABASE radioso SET pgaudit.log = 'read, write, ddl, role, misc_set';

-- Engineers get table data through a group role, so a later per-person IAM user needs one grant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'radioso_support') THEN
    CREATE ROLE radioso_support NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO radioso_support;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO radioso_support;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO radioso_support;

-- Tables later migrations create.
ALTER DEFAULT PRIVILEGES FOR ROLE radioso IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO radioso_support;
ALTER DEFAULT PRIVILEGES FOR ROLE radioso IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO radioso_support;

GRANT radioso_support TO :"support_user";

-- What the setup left behind, for the run's output.
SELECT datname, setconfig
FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
WHERE s.setrole = 0;
SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'radioso';
SELECT r.rolname AS member_of_radioso_support
FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
WHERE m.roleid = 'radioso_support'::regrole;
SELECT count(*) AS tables_granted
FROM information_schema.role_table_grants
WHERE grantee = 'radioso_support' AND privilege_type = 'SELECT';
