import { sql, type SqlBool } from "kysely";

/**
 * The single definition of "this document's chunks are retrievable right now":
 * the document is fully processed ('ready'), is enabled for retrieval, and its
 * retrieval expiry (if any) has not yet elapsed.
 *
 * Spliced into every chunk-candidate query — vector, lexical, index hydration,
 * and temporal — so the enable flag and expiry apply uniformly across all
 * retrieval paths. Both are orthogonal to processing status: a disabled or
 * expired document stays visible in the dashboard, it is only kept out of
 * retrieval.
 *
 * The alias is caller-supplied but always a hard-coded query identifier (never
 * user input), so string interpolation here is safe.
 */
export const retrievableDocumentPredicateSql = (documentAlias: string): string =>
  `${documentAlias}.status = 'ready' ` +
  `AND ${documentAlias}.retrieval_enabled = true ` +
  `AND (${documentAlias}.retrieval_expires_at IS NULL OR ${documentAlias}.retrieval_expires_at > now())`;

/**
 * Kysely `where(...)` form of {@link retrievableDocumentPredicateSql} for
 * query-builder call sites that don't build raw SQL strings.
 */
export const retrievableDocumentWhere = (documentAlias: string) =>
  sql<SqlBool>`${sql.raw(retrievableDocumentPredicateSql(documentAlias))}`;
