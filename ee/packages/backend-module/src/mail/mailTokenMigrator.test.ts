import { describe, expect, it } from "vitest";

import type { ApplicationDatabasePort } from "../radiosoModuleTypes.js";
import { mailTokenMigrator } from "./mailTokenMigrator.js";

class RecordingDatabase implements ApplicationDatabasePort {
  readonly queries: string[] = [];

  async query<T = Record<string, unknown>>(text: string): Promise<T[]> {
    this.queries.push(text);
    return [];
  }
}

describe("enterprise mail token migrator", () => {
  it("creates Enterprise-owned password reset and email verification token tables", async () => {
    const database = new RecordingDatabase();

    await mailTokenMigrator.migrate(database);

    const sql = database.queries.join("\n");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ee_password_reset_tokens");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ee_email_verification_tokens");
    expect(sql).toContain("idx_ee_password_reset_tokens_user_active");
    expect(sql).toContain("idx_ee_email_verification_tokens_user_active");
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS password_reset_tokens");
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS email_verification_tokens");
  });
});
