import type { ApplicationDatabaseMigrator } from "../radiosoModuleTypes.js";

export const mailTokenMigrator: ApplicationDatabaseMigrator = {
  id: "ee-mail-tokens",
  async migrate(database) {
    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_password_reset_tokens (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        request_ip TEXT,
        request_user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_password_reset_tokens_user_created
        ON ee_password_reset_tokens (user_id, created_at DESC)
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_password_reset_tokens_user_active
        ON ee_password_reset_tokens (user_id, expires_at DESC)
        WHERE used_at IS NULL
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_email_verification_tokens (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        request_ip TEXT,
        request_user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_email_verification_tokens_user_created
        ON ee_email_verification_tokens (user_id, created_at DESC)
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_email_verification_tokens_user_active
        ON ee_email_verification_tokens (user_id, expires_at DESC)
        WHERE used_at IS NULL
    `);
  },
};
