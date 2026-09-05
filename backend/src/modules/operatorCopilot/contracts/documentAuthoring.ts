import { z } from "zod";

import { MAX_COPILOT_PROPOSAL_SUMMARY } from "../contracts.js";

import { documentMetadataRecordSchema } from "../../documents/public.js";

/**
 * How much text Ray may author into one proposed document. A knowledge document it writes is
 * answering a specific gap, not reproducing a manual, and the whole body is stored on the proposal
 * and rendered on the review card.
 */
export const MAX_COPILOT_DOCUMENT_CONTENT = 20_000;

export const copilotDocumentTargetRefSchema = z.object({
  documentId: z.string().uuid().nullable(),
}).strict();

const rationaleSchema = z.string().trim().min(1).max(1_000);
const titleSchema = z.string().trim().min(1).max(300);

/**
 * A create carries no `externalDocumentId`. Ingestion upserts on that key, so a create naming one
 * that already exists would replace a stored document's entire body under a card that says
 * "create" — and Ray has no way to know what it was replacing. Documents that carry an external
 * identity are written by the integration that owns it.
 */
const copilotDocumentCreatePayloadSchema = z.object({
  op: z.literal("create"),
  /** The document's title. Named `name` because that is what every proposal card reads a target's
   * label from, whatever the target is. */
  name: titleSchema,
  content: z.string().trim().min(1).max(MAX_COPILOT_DOCUMENT_CONTENT),
  metadata: documentMetadataRecordSchema.optional(),
  rationale: rationaleSchema.optional(),
  /** The sentence the card states. Stored so a reloaded card reads what the live one did. */
  summary: z.string().min(1).max(MAX_COPILOT_PROPOSAL_SUMMARY).optional(),
}).strict();

/**
 * The retrieval-facing half of a document: whether it is eligible, when eligibility lapses, and the
 * metadata retrieval filters and boosts on. Deliberately no `content` — Ray reads documents as
 * search snippets and paged chunks, both derived and partial, so it cannot author a faithful
 * replacement body for one.
 */
const retrievalChangeFields = {
  retrievalEnabled: z.boolean().optional(),
  retrievalExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  metadata: documentMetadataRecordSchema.optional(),
};

const copilotDocumentRetrievalChangeSchema = z.object({
  op: z.literal("update_retrieval"),
  ...retrievalChangeFields,
  rationale: rationaleSchema.optional(),
}).strict();

const copilotDocumentDeleteChangeSchema = z.object({
  op: z.literal("delete"),
  removesTarget: z.literal(true),
  rationale: rationaleSchema.optional(),
}).strict();

/**
 * What a tool asks for. A change to a stored document names no title: the card must show the title
 * the document actually has at draft time, which only the adapter's own read can supply.
 */
const copilotDocumentCreateChangeSchema = copilotDocumentCreatePayloadSchema.omit({ summary: true });

export const copilotDocumentChangeSchema = z.discriminatedUnion("op", [
  copilotDocumentCreateChangeSchema,
  copilotDocumentRetrievalChangeSchema,
  copilotDocumentDeleteChangeSchema,
]);

const copilotDocumentRetrievalPayloadSchema = z.object({
  op: z.literal("update_retrieval"),
  /** The document's title when the draft was made, so the card can name its target. */
  name: titleSchema,
  ...retrievalChangeFields,
  rationale: rationaleSchema.optional(),
  /** The sentence the card states. Stored so a reloaded card reads what the live one did. */
  summary: z.string().min(1).max(MAX_COPILOT_PROPOSAL_SUMMARY).optional(),
}).strict();

const copilotDocumentDeletePayloadSchema = z.object({
  op: z.literal("delete"),
  name: titleSchema,
  /** Applying this deletes the target. Stated on the payload so a reloaded card can warn about it
   * without the reader knowing each target type's word for deletion. */
  removesTarget: z.literal(true),
  rationale: rationaleSchema.optional(),
  /** The sentence the card states. Stored so a reloaded card reads what the live one did. */
  summary: z.string().min(1).max(MAX_COPILOT_PROPOSAL_SUMMARY).optional(),
}).strict();

/** What is stored on the proposal and read back by preview and apply. */
export const copilotDocumentPayloadSchema = z.discriminatedUnion("op", [
  copilotDocumentCreatePayloadSchema,
  copilotDocumentRetrievalPayloadSchema,
  copilotDocumentDeletePayloadSchema,
]);

export type CopilotDocumentChange = z.infer<typeof copilotDocumentChangeSchema>;
export type CopilotDocumentPayload = z.infer<typeof copilotDocumentPayloadSchema>;

/**
 * A document as the copilot may see it. The stored body is absent by construction rather than by
 * convention: nothing on this port can hand Ray a document's full text, so no adapter or tool
 * written against it can leak one into a model turn.
 */
export interface CopilotDocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly metadata: Record<string, unknown>;
  readonly retrievalEnabled: boolean;
  readonly retrievalExpiresAt: Date | null;
  readonly updatedAt: Date;
}

export interface CopilotDocumentAuthoringPort {
  getDocument(workspaceId: string, documentId: string): Promise<CopilotDocumentSummary>;
  ingest(input: {
    workspaceId: string;
    accountId?: string | null;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ documentId: string }>;
  /**
   * One call because metadata and retrieval eligibility settle in one statement. Applying a
   * proposal that named both must not be able to land half of it and then report that the whole
   * change failed. `expectedUpdatedAt` carries the version the card was drafted against into the
   * write's own predicate, so an edit that landed in between is refused rather than overwritten.
   */
  updateRetrievalSettings(input: {
    workspaceId: string;
    documentId: string;
    metadata?: Record<string, unknown>;
    retrievalEnabled?: boolean;
    retrievalExpiresAt?: Date | null;
    expectedUpdatedAt?: Date;
  }): Promise<unknown>;
}

export interface CopilotDocumentDeletionPort {
  delete(input: { workspaceId: string; documentId: string; expectedUpdatedAt?: Date }): Promise<unknown>;
}

/**
 * Applying a proposal reaches the ingestion service without the request that carried an account,
 * and ingestion reserves document and storage quota against one. Resolving it here keeps an applied
 * create inside the same tier caps an operator-driven upload pays, instead of quietly outside them.
 */
export interface CopilotWorkspaceAccountResolver {
  resolveAccountId(workspaceId: string): Promise<string | null>;
}
