import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface BootstrapGreetingCacheRecord {
  id: string;
  workspaceId: string;
  fingerprint: string;
  localeUsed: string | null;
  greetingText: string;
  createdAt: Date;
  updatedAt: Date;
}

interface BootstrapGreetingCacheRow {
  id: string;
  workspace_id: string;
  fingerprint: string;
  locale_used: string | null;
  greeting_text: string;
  created_at: Date;
  updated_at: Date;
}

const mapRecord = (row: BootstrapGreetingCacheRow): BootstrapGreetingCacheRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  fingerprint: row.fingerprint,
  localeUsed: row.locale_used,
  greetingText: row.greeting_text,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface BootstrapGreetingCacheRepositoryPort {
  findByWorkspaceAndFingerprint(workspaceId: string, fingerprint: string): Promise<BootstrapGreetingCacheRecord | null>;
  save(input: {
    workspaceId: string;
    fingerprint: string;
    localeUsed: string | null;
    greetingText: string;
  }): Promise<BootstrapGreetingCacheRecord>;
}

export class BootstrapGreetingCacheRepository implements BootstrapGreetingCacheRepositoryPort {
  constructor(private readonly database: Database) {}

  async findByWorkspaceAndFingerprint(workspaceId: string, fingerprint: string): Promise<BootstrapGreetingCacheRecord | null> {
    const row = await this.database.queryOptional<BootstrapGreetingCacheRow>(
      `SELECT id, workspace_id, fingerprint, locale_used, greeting_text, created_at, updated_at
       FROM bootstrap_greeting_cache
       WHERE workspace_id = $1 AND fingerprint = $2`,
      [workspaceId, fingerprint],
    );

    return row ? mapRecord(row) : null;
  }

  async save(input: {
    workspaceId: string;
    fingerprint: string;
    localeUsed: string | null;
    greetingText: string;
  }): Promise<BootstrapGreetingCacheRecord> {
    const row = await this.database.queryOne<BootstrapGreetingCacheRow>(
      `INSERT INTO bootstrap_greeting_cache (id, workspace_id, fingerprint, locale_used, greeting_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, fingerprint)
       DO UPDATE SET locale_used = EXCLUDED.locale_used,
                     greeting_text = EXCLUDED.greeting_text,
                     updated_at = NOW()
       RETURNING id, workspace_id, fingerprint, locale_used, greeting_text, created_at, updated_at`,
      [randomUUID(), input.workspaceId, input.fingerprint, input.localeUsed, input.greetingText],
    );

    return mapRecord(row);
  }
}
