import { Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";

import type { DB } from "./schema.js";

/**
 * Build a Kysely instance on an **existing** `pg.Pool`.
 *
 * The pool is owned by `Database` (`src/shared/infra/database.ts`); its configuration
 * (timeouts, application_name) and lifecycle — including `close()` / `pool.end()` — stay
 * there. Sharing the pool means Kysely and any not-yet-migrated raw-SQL paths use one
 * pool and one transaction context throughout the migration.
 *
 * Do NOT call `.destroy()` on the returned instance: that would end the shared pool.
 * Closing is the `Database`'s responsibility.
 */
export const createKyselyDatabase = (pool: Pool): Kysely<DB> =>
  new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
