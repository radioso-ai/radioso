import type { ConnectorDatabasePort } from "@radioso/connector-api";

import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * Bridge from the published, query-only `ConnectorDatabasePort` to the Kysely `Db` that
 * Kysely-migrated repositories require.
 *
 * The value injected as `ConnectorContext.db` at runtime is the full internal `Database`
 * (`src/app/server/dependencies.ts`: `connectorDb: infrastructure.database`), which exposes
 * `.kysely`. The published `@radioso/connector-api` contract only declares `query()`, so this
 * cast is the documented seam until that contract evolves to carry a Kysely handle.
 *
 * Tracked follow-up (spec 093): when `@radioso/connector-api` exposes Kysely, `connectorRegistry`
 * and `whatsappPlugin.migrate` (still on the raw `query()` contract, US4-allowlisted) can migrate
 * and this bridge can be removed.
 */
export const connectorKyselyDb = (db: ConnectorDatabasePort): Db =>
  (db as unknown as { kysely: Db }).kysely;
