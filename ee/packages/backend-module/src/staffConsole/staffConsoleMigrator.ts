import type { ApplicationDatabaseMigrator } from "../radiosoModuleTypes.js";

export const staffConsoleMigrator: ApplicationDatabaseMigrator = {
  id: "ee-staff-console",
  async migrate(database) {
    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_staff_users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ,
        CONSTRAINT ee_staff_users_role_check
          CHECK (role IN ('support_read', 'billing_write', 'owner')),
        CONSTRAINT ee_staff_users_status_check
          CHECK (status IN ('active', 'disabled'))
      )
    `);

    await database.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_staff_users_email_lower_unique
        ON ee_staff_users (LOWER(email))
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_staff_sessions (
        id UUID PRIMARY KEY,
        staff_id UUID NOT NULL REFERENCES ee_staff_users(id) ON DELETE CASCADE,
        session_token_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ
      )
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_staff_sessions_staff_id
        ON ee_staff_sessions (staff_id)
    `);

    await database.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_staff_sessions_token_hash_unique
        ON ee_staff_sessions (session_token_hash)
    `);
  },
};
