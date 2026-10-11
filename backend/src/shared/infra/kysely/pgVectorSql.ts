import { sql, type Expression, type RawBuilder } from "kysely";

/**
 * Kysely fragments for PostgreSQL's pgvector extension.
 *
 * Repositories use these fragments for pgvector-backed columns while the retrieval
 * adapter owns candidate search and index lifecycle. Keeping extension syntax here
 * makes that dependency explicit and keeps ordinary data-access code portable.
 */
export const serializePgVector = (embedding: readonly number[]): string =>
  `[${embedding.join(",")}]`;

/** Cast a serialized vector literal for assignment or comparison. */
export const toPgVector = (value: string): RawBuilder<string> =>
  sql`${value}::vector`;

/** Read a pgvector value in its PostgreSQL text representation. */
export const pgVectorText = (value: Expression<unknown>): RawBuilder<string> =>
  sql`${value}::text`;

/** Cosine distance between pgvector expressions. */
export const pgVectorCosineDistance = (
  left: Expression<unknown>,
  right: Expression<unknown>,
): RawBuilder<number> => sql`${left} <=> ${right}`;
