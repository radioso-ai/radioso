import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface BootstrapGreetingCacheRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  fingerprint: string;
  localeUsed: string | null;
  greetingText: string;
  createdAt: Date;
  updatedAt: Date;
}

interface BootstrapGreetingCacheRow {
  // SQL rows keep database column names; repository records are the camelCase boundary type.
  id: string;
  workspace_id: string;
  agent_id: string;
  fingerprint: string;
  locale_used: string | null;
  greeting_text: string;
  created_at: Date;
  updated_at: Date;
}

const greetingCacheColumns = [
  "id",
  "workspace_id",
  "agent_id",
  "fingerprint",
  "locale_used",
  "greeting_text",
  "created_at",
  "updated_at",
] as const;

const mapRecord = (row: BootstrapGreetingCacheRow): BootstrapGreetingCacheRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  fingerprint: row.fingerprint,
  localeUsed: row.locale_used,
  greetingText: row.greeting_text,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export interface BootstrapGreetingCacheRepositoryPort {
  findByWorkspaceAgentAndFingerprint(workspaceId: string, agentId: string, fingerprint: string): Promise<BootstrapGreetingCacheRecord | null>;
  findById(workspaceId: string, id: string): Promise<BootstrapGreetingCacheRecord | null>;
  save(input: {
    workspaceId: string;
    agentId: string;
    fingerprint: string;
    localeUsed: string | null;
    greetingText: string;
  }): Promise<BootstrapGreetingCacheRecord>;
}

export class BootstrapGreetingCacheRepository implements BootstrapGreetingCacheRepositoryPort {
  constructor(private readonly db: Db) {}

  async findByWorkspaceAgentAndFingerprint(
    workspaceId: string,
    agentId: string,
    fingerprint: string,
  ): Promise<BootstrapGreetingCacheRecord | null> {
    const row = await this.db
      .selectFrom("bootstrap_greeting_cache")
      .select(greetingCacheColumns)
      .where("workspace_id", "=", workspaceId)
      .where("agent_id", "=", agentId)
      .where("fingerprint", "=", fingerprint)
      .executeTakeFirst();

    return row ? mapRecord(row) : null;
  }

  async findById(workspaceId: string, id: string): Promise<BootstrapGreetingCacheRecord | null> {
    const row = await this.db
      .selectFrom("bootstrap_greeting_cache")
      .select(greetingCacheColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", id)
      .executeTakeFirst();

    return row ? mapRecord(row) : null;
  }

  async save(input: {
    workspaceId: string;
    agentId: string;
    fingerprint: string;
    localeUsed: string | null;
    greetingText: string;
  }): Promise<BootstrapGreetingCacheRecord> {
    const row = await this.db
      .insertInto("bootstrap_greeting_cache")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        agent_id: input.agentId,
        fingerprint: input.fingerprint,
        locale_used: input.localeUsed,
        greeting_text: input.greetingText,
      })
      .onConflict((oc) =>
        oc.columns(["workspace_id", "agent_id", "fingerprint"]).doUpdateSet((eb) => ({
          locale_used: eb.ref("excluded.locale_used"),
          greeting_text: eb.ref("excluded.greeting_text"),
          updated_at: currentTimestamp(),
        })),
      )
      .returning(greetingCacheColumns)
      .executeTakeFirstOrThrow();

    return mapRecord(row);
  }
}
