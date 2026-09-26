import { z } from "zod";

const reviewedImportDocumentSchema = z.object({
  externalDocumentId: z.string().min(1).max(240),
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(20_000),
  metadata: z.record(z.unknown()).optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedDocumentId: z.string().uuid().nullable(),
  expectedRevision: z.number().int().nullable(),
  expectedContentHash: z.string().nullable(),
  indexedBytes: z.number().int().nonnegative(),
  storageDeltaBytes: z.number().int().nonnegative(),
  action: z.enum(["create", "replace", "unchanged"]),
}).strict();

export const documentReviewedOperationTargetRefSchema = z.object({
  sourceId: z.string().uuid().nullable(),
}).strict();

export const documentReviewedImportPlanSchema = z.object({
  operation: z.literal("import"),
  documents: z.array(reviewedImportDocumentSchema).min(1).max(100),
  fence: z.string().min(1).max(100),
}).strict();

export const documentReviewedRemovalPlanSchema = z.object({
  operation: z.literal("removal"),
  documents: z.array(z.object({ id: z.string().uuid(), title: z.string().max(300), updatedAt: z.string().datetime() }).strict()).min(1).max(200),
  unknownIds: z.array(z.string()).max(200),
  fence: z.string().min(1).max(100),
}).strict();

export const documentReviewedReprocessPlanSchema = z.object({
  operation: z.literal("reprocess"),
  documents: z.array(z.object({ id: z.string().uuid(), updatedAt: z.string().datetime(), status: z.string() }).strict()).min(1).max(200),
  fence: z.string().min(1).max(100),
}).strict();

/** The bounded, persisted plan Documents owns for every reviewed document operation. */
export const documentReviewedOperationPlanSchema = z.discriminatedUnion("operation", [
  documentReviewedImportPlanSchema,
  documentReviewedRemovalPlanSchema,
  documentReviewedReprocessPlanSchema,
]);

export type DocumentReviewedOperationPlan = z.infer<typeof documentReviewedOperationPlanSchema>;
export type DocumentReviewedOperationTargetRef = z.infer<typeof documentReviewedOperationTargetRefSchema>;
export type DocumentReviewedImportPlan = z.infer<typeof documentReviewedImportPlanSchema>;
export type DocumentReviewedRemovalPlan = z.infer<typeof documentReviewedRemovalPlanSchema>;
export type DocumentReviewedReprocessPlan = z.infer<typeof documentReviewedReprocessPlanSchema>;

/** Bounded review projection for transports; it does not re-decide document state. */
export const describeDocumentReviewedOperationPlan = (plan: DocumentReviewedOperationPlan) => {
  if (plan.operation === "import") {
    const documents = plan.documents.map(({ externalDocumentId, title, contentHash, action }) => ({ externalDocumentId, title, contentHash, action }));
    return { documentCount: plan.documents.length, review: { counts: { create: documents.filter((document) => document.action === "create").length, replace: documents.filter((document) => document.action === "replace").length, unchanged: documents.filter((document) => document.action === "unchanged").length }, documents: documents.slice(0, 40), documentsTruncated: documents.length > 40 }, fullReview: { documents } };
  }
  if (plan.operation === "removal") {
    return { documentCount: plan.documents.length, review: { documents: plan.documents.slice(0, 40), unknownIds: plan.unknownIds, documentsTruncated: plan.documents.length > 40 }, fullReview: { documents: plan.documents, unknownIds: plan.unknownIds } };
  }
  const eligible = plan.documents.filter((document) => document.status !== "queued" && document.status !== "processing").length;
  return { documentCount: plan.documents.length, review: { eligible, skipped: plan.documents.length - eligible }, fullReview: { documents: plan.documents } };
};
