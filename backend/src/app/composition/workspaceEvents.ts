import type { Kysely } from "kysely";

import { WorkspaceEventRepository } from "../../db/repositories/workspaceEventRepository.js";
import { WorkspaceEventLog } from "../../modules/workspaceEvents/public.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * The workspace event log's read side over Postgres. Its write side is the stateless
 * `postgresWorkspaceEventRecorder`, which each owning module's construction is handed directly:
 * conversation creation, the chat turn's persistence, the notify outbox and the activity bridge.
 */
export const buildWorkspaceEventLog = (db: Kysely<DB>): WorkspaceEventLog =>
  new WorkspaceEventLog({ store: new WorkspaceEventRepository(db) });
