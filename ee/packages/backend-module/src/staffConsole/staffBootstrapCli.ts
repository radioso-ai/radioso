/**
 * Entry point for creating the first operator console owner or recovering a locked-out one. Wires
 * the process (argv, env, stdout/stderr) and a Postgres pool into the command; all behavior lives
 * in staffBootstrapCommand.ts and staffBootstrap.ts. Stdout is the audit trail's second copy: the
 * structured line is what the privileged-change alert matches when this runs as a Cloud Run job.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { StaffBootstrapService } from "./staffBootstrap.js";
import { runStaffBootstrapCommand } from "./staffBootstrapCommand.js";
import { PostgresStaffUserRepository } from "./staffRepository.js";
import { StaffSecurityEvents } from "./staffSecurityEvents.js";
import { PostgresStaffSessionRepository } from "./staffSessionRepository.js";

const createBootstrapService = (databaseUrl: string) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const database: UsageLimitDatabasePort = {
    pool,
    query: async <T>(text: string, params?: unknown[]): Promise<T[]> =>
      (await pool.query(text, params)).rows as T[],
  };
  const events = new StaffSecurityEvents(
    {
      record: (input) => database.query(
        `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          randomUUID(),
          input.accountId ?? null,
          input.workspaceId ?? null,
          input.eventType,
          input.eventStatus,
          JSON.stringify(input.metadata ?? {}),
        ],
      ),
    },
    {
      warn: (entry, message) => {
        process.stdout.write(`${JSON.stringify({ severity: "WARNING", message, ...(entry as object) })}\n`);
      },
    },
  );
  return {
    service: new StaffBootstrapService(
      new PostgresStaffUserRepository(database),
      new PostgresStaffSessionRepository(database),
      events,
    ),
    close: () => pool.end(),
  };
};

process.exitCode = await runStaffBootstrapCommand({
  argv: process.argv.slice(2),
  env: process.env,
  createBootstrapService,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
