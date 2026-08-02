import { sql, type SqlBool } from "kysely";

/**
 * Shared persistence definition of a document whose current chunks may take part in
 * semantic retrieval. Internal consumers use this same predicate so corpus evidence
 * cannot accidentally consider disabled, expired, or incomplete documents.
 */
export const retrievableDocumentPredicateSql = (documentAlias: string): string =>
  `${documentAlias}.status = 'ready' `
  + `AND ${documentAlias}.retrieval_enabled = true `
  + `AND (${documentAlias}.retrieval_expires_at IS NULL OR ${documentAlias}.retrieval_expires_at > now())`;

export const retrievableDocumentWhere = (documentAlias: string) =>
  sql<SqlBool>`${sql.raw(retrievableDocumentPredicateSql(documentAlias))}`;
