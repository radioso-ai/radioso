import { z } from "zod";

import { documentMetadataRecordSchema } from "./documentMetadata.js";

/**
 * Shared field definitions for the two request shapes that carry a document body or its
 * retrieval settings: the REST routes in `app/http/routes/documentRouteSchemas.ts` and the
 * operator-copilot document proposal tools in `modules/operatorCopilot/tools/documentProposals.ts`.
 * Each caller adds its own request-shape rules (`.strict()`, a "provide at least one field"
 * refinement, addressing fields such as `documentId`) on top of these; the field definitions
 * themselves stay in one place so the two surfaces cannot silently drift apart.
 */

export const documentEnrichmentOverrideSchema = z.enum(["on", "off"]);

const documentSourceSchema = z.union([
  z.object({
    id: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("website"),
    url: z.string().trim().url().refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }, "source.url must use http or https"),
  }).strict(),
]);

/** The fields a document-retrieval change may set: eligibility, its expiry, and its tag map. */
export const documentRetrievalUpdateFieldsSchema = z.object({
  retrievalEnabled: z.boolean().optional(),
  // `null` clears the expiry; an ISO 8601 timestamp sets it. Absent leaves the
  // stored value unchanged.
  retrievalExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  // A full replace of the operator-authored tag map. Present-but-empty clears
  // every tag; absent leaves the stored map unchanged.
  metadata: documentMetadataRecordSchema.optional(),
});

/** The fields an inline (non-crawled) document body and its authoring metadata carry. */
export const inlineDocumentFieldsSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: documentMetadataRecordSchema.optional(),
  externalDocumentId: z.string().trim().min(1).optional(),
  source: documentSourceSchema.optional(),
  documentEnrichmentOverride: documentEnrichmentOverrideSchema.optional(),
});
