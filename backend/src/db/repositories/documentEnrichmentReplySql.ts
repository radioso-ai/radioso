import { sql, type RawBuilder } from "kysely";

import type { JsonValue } from "../../shared/infra/kysely/schema.js";

/**
 * A document's stored extraction reply quotes its title and text, so a write that changes either
 * drops it rather than keep quotes of content the document no longer holds.
 */
export const enrichmentReplyAfterContentWrite = (next: { title?: string; markdownContent: string }): RawBuilder<JsonValue | null> =>
  next.title === undefined
    ? sql`CASE WHEN documents.markdown_content IS DISTINCT FROM ${next.markdownContent} THEN NULL ELSE documents.enrichment_reply END`
    : sql`CASE WHEN documents.markdown_content IS DISTINCT FROM ${next.markdownContent} OR documents.title IS DISTINCT FROM ${next.title} THEN NULL ELSE documents.enrichment_reply END`;

export const enrichmentReplyAfterUpsert = (): RawBuilder<JsonValue | null> =>
  sql`CASE WHEN documents.markdown_content IS DISTINCT FROM excluded.markdown_content OR documents.title IS DISTINCT FROM excluded.title THEN NULL ELSE documents.enrichment_reply END`;
