import type { Kysely, Transaction } from "kysely";

import type { DB } from "./schema.js";

export type { DB } from "./schema.js";

/**
 * The executor a repository depends on.
 *
 * Both a {@link Kysely} instance and a {@link Transaction} expose the same
 * query-builder API, so a repository method behaves identically whether it runs
 * standalone (on the shared pool) or inside a caller's transaction. Repositories that
 * participate in multi-statement atomic operations accept this type and the
 * orchestrating service threads a `Transaction<DB>` to each.
 *
 * This replaces the previous `Database` / `DatabaseExecutor` injection. Domain modules
 * never see it — they depend only on `*RepositoryPort` interfaces.
 */
export type Db = Kysely<DB> | Transaction<DB>;
