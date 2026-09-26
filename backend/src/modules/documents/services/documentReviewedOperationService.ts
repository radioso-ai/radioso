import { createHash } from "node:crypto";
import type { z } from "zod";
import { AppError, badRequest } from "../../../shared/domain/errors.js";
import type { DocumentCapacityReadPort } from "../../../shared/domain/usageLimitPolicy.js";
import type { DocumentRepositoryPort } from "../contracts/documentContracts.js";
import { describeInlineDocumentForIngestion, type DocumentIngestionService } from "./documentIngestionService.js";
import type { DocumentDeletionService } from "./documentDeletionService.js";
import type { DocumentSourceReprocessService } from "./documentSourceReprocessService.js";
import type { WorkspaceIngestionReprocessService } from "./workspaceIngestionReprocessService.js";
import {
  documentReviewedImportPlanSchema,
  documentReviewedRemovalPlanSchema,
  documentReviewedReprocessPlanSchema,
  type DocumentReviewedImportPlan,
  type DocumentReviewedOperationPlan,
  type DocumentReviewedOperationTargetRef,
  type DocumentReviewedRemovalPlan,
  type DocumentReviewedReprocessPlan,
} from "./documentReviewedOperationPlan.js";

type ReviewedImportDocument = {
  readonly externalDocumentId: string;
  readonly title: string;
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
};

type ReviewedImportPlanItem = DocumentReviewedImportPlan["documents"][number];

/**
 * The documents owner computes identity, capacity and mutation outcomes. The copilot layer only
 * persists this service's immutable plan; it never repeats document hash or quota rules.
 */
export class DocumentReviewedOperationService {
  constructor(
    private readonly documents: Pick<DocumentRepositoryPort, "findActivePageState" | "findPageState" | "listSummariesByIdsAndWorkspaceId" | "findByExternalDocumentId" | "findBySourceAndExternalDocumentId" | "countReprocessCandidates" | "listSummaryPageByWorkspaceId" | "listSummaryPageBySourceId">,
    private readonly ingestion: Pick<DocumentIngestionService, "ingest" | "reprocessEligible">,
    private readonly deletion: Pick<DocumentDeletionService, "delete">,
    private readonly documentCapacity: DocumentCapacityReadPort,
    private readonly sourceReprocess?: Pick<DocumentSourceReprocessService, "reprocessSource">,
    private readonly workspaceReprocess?: Pick<WorkspaceIngestionReprocessService, "reprocessWorkspace">,
  ) {}

  async prepareImport(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly sourceId: string | null;
    readonly documents: readonly ReviewedImportDocument[];
  }): Promise<DocumentReviewedImportPlan> {
    const seen = new Set<string>();
    for (const document of input.documents) {
      if (seen.has(document.externalDocumentId)) throw badRequest(`externalDocumentId "${document.externalDocumentId}" appears more than once.`);
      seen.add(document.externalDocumentId);
    }
    const plan = await Promise.all(input.documents.map(async (document) => {
      const projected = describeInlineDocumentForIngestion(document);
      const { active, state: existing } = await this.resolveImportPageState(input.workspaceId, input.sourceId, document.externalDocumentId);
      // A failed row still owns the upsert key, but normal ingestion deliberately excludes it
      // from its idempotency shortcut and reserves the full next revision.
      return {
        ...document,
        contentHash: projected.contentHash,
        expectedDocumentId: existing?.documentId ?? null,
        expectedRevision: existing?.revision ?? null,
        expectedContentHash: existing?.contentHash ?? null,
        indexedBytes: projected.contentSizeBytes,
        storageDeltaBytes: Math.max(0, projected.contentSizeBytes - (active?.contentSizeBytes ?? 0)),
        action: !active ? (existing ? "replace" as const : "create" as const) : active.contentHash === projected.contentHash ? "unchanged" as const : "replace" as const,
      };
    }));
    const usage = await this.documentCapacity.getDocumentCapacityUsage({ accountId: input.accountId, workspaceId: input.workspaceId });
    const creates = plan.filter((document) => document.action === "create").length;
    const storageDelta = plan.reduce((total, document) => total + document.storageDeltaBytes, 0);
    const monthlyBytes = plan.filter((document) => document.action !== "unchanged").reduce((total, document) => total + document.indexedBytes, 0);
    const exceeds = (usageWindow: { used: number; limit: number | null }, requested: number) => usageWindow.limit !== null && usageWindow.used + requested > usageWindow.limit;
    if (exceeds(usage.storedDocuments, creates)) {
      throw badRequest(`Import would exceed stored_documents: limit ${usage.storedDocuments.limit}, current ${usage.storedDocuments.used}, requested new ${creates}.`);
    }
    if (exceeds(usage.storedIndexedBytes, storageDelta)) {
      throw badRequest(`Import would exceed stored_indexed_bytes: limit ${usage.storedIndexedBytes.limit}, current ${usage.storedIndexedBytes.used}, requested ${storageDelta}.`);
    }
    if (exceeds(usage.monthlyIndexedBytes, monthlyBytes)) {
      throw badRequest(`Import would exceed monthly_indexed_bytes: limit ${usage.monthlyIndexedBytes.limit}, current ${usage.monthlyIndexedBytes.used}, requested ${monthlyBytes}.`);
    }
    return this.parsePlan(documentReviewedImportPlanSchema, {
      operation: "import",
      documents: plan,
      fence: createHash("sha256").update(JSON.stringify(plan.map(({ externalDocumentId, expectedDocumentId, expectedRevision, expectedContentHash, contentHash }) => ({ externalDocumentId, expectedDocumentId, expectedRevision, expectedContentHash, contentHash })))).digest("base64url"),
    });
  }

  async import(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly sourceId: string | null;
    readonly documents: readonly ReviewedImportPlanItem[];
  }): Promise<{ readonly counts: Record<"created" | "replaced" | "unchanged" | "failed", number>; readonly failures: readonly { externalDocumentId: string; code: string }[] }> {
    const counts = { created: 0, replaced: 0, unchanged: 0, failed: 0 };
    const failures: { externalDocumentId: string; code: string }[] = [];
    for (const document of input.documents) {
      const before = await this.documents.findActivePageState({ workspaceId: input.workspaceId, sourceId: input.sourceId, externalDocumentId: document.externalDocumentId });
      if (before?.contentHash === document.contentHash) {
        if (document.action === "replace") counts.replaced += 1;
        else if (document.action === "create") counts.created += 1;
        else counts.unchanged += 1;
        continue;
      }
      try {
        const result = await this.ingestion.ingest({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          title: document.title,
          content: document.content,
          ...(document.metadata ? { metadata: document.metadata } : {}),
          externalDocumentId: document.externalDocumentId,
          reviewedWriteGuard: {
            expectedDocumentId: document.expectedDocumentId,
            expectedRevision: document.expectedRevision,
            expectedContentHash: document.expectedContentHash,
          },
          ...(input.sourceId ? { source: { id: input.sourceId } } : {}),
        });
        // `ready` is the ingestion owner's unchanged-hash result. A changed row queues again.
        if (result.status === "ready") counts.unchanged += 1;
        else if (document.action === "replace") counts.replaced += 1;
        else counts.created += 1;
      } catch (error) {
        const current = await this.documents.findActivePageState({ workspaceId: input.workspaceId, sourceId: input.sourceId, externalDocumentId: document.externalDocumentId });
        if (current?.contentHash === document.contentHash) {
          if (document.action === "replace") counts.replaced += 1;
          else if (document.action === "create") counts.created += 1;
          else counts.unchanged += 1;
        } else {
          counts.failed += 1;
          failures.push({ externalDocumentId: document.externalDocumentId, code: error instanceof AppError ? error.code : "internal_error" });
        }
      }
    }
    return { counts, failures };
  }

  /**
   * An MCP receipt can be lost after this owner has written its effect.  This deliberately
   * reads only document-owned state: it never replays an ingest merely to discover whether an
   * earlier caller got a response.  Reprocess is conservative because a completed worker job
   * does not retain a per-reviewed-operation marker; it remains unconfirmed rather than queueing
   * a second embedding pass.
   */
  async reconcileInterruptedApply(input: {
    readonly workspaceId: string;
    readonly targetRef: DocumentReviewedOperationTargetRef;
    readonly plan: DocumentReviewedOperationPlan;
  }): Promise<{ readonly outcome: "applied"; readonly appliedRef: unknown } | { readonly outcome: "not_applied" } | { readonly outcome: "unknown"; readonly reason: string }> {
    if (input.plan.operation === "reprocess") {
      const documents = input.plan.documents;
      const current = await this.documents.listSummariesByIdsAndWorkspaceId(input.workspaceId, documents.map((document) => document.id));
      const byId = new Map(current.map((document) => [document.id, document]));
      const pending = documents.filter((document) => byId.get(document.id)?.updatedAt.toISOString() === document.updatedAt);
      if (pending.length > 0) return { outcome: "not_applied" };
      const changed = documents.filter((document) => { const row = byId.get(document.id); return !row || (row.status !== "queued" && row.status !== "processing"); });
      return { outcome: "applied", appliedRef: { queued: documents.length - changed.length, skipped: 0, failed: changed.length, failures: changed.slice(0, 40).map((document) => ({ documentId: document.id, code: "conflict" })), reconciled: true } };
    }
    if (input.plan.operation === "removal") {
      const ids = input.plan.documents.map((document) => document.id);
      const present = await this.documents.listSummariesByIdsAndWorkspaceId(input.workspaceId, ids);
      if (present.length === 0) {
        return { outcome: "applied", appliedRef: { counts: { removed: ids.length, changed: 0, alreadyRemoved: 0, failed: 0 }, failures: [], reconciled: true } };
      }
      return { outcome: "not_applied" };
    }
    const documents = input.plan.documents;
    const states = await Promise.all(documents.map(async (document) => ({
      document,
      current: (await this.resolveImportPageState(input.workspaceId, input.targetRef.sourceId, document.externalDocumentId)).state,
    })));
    const applied = states.every(({ document, current }) => {
      if (document.action === "unchanged") return current?.documentId === document.expectedDocumentId && current?.contentHash === document.contentHash;
      return current?.documentId !== null && current?.contentHash === document.contentHash && current?.documentId !== undefined;
    });
    if (!applied) return { outcome: "not_applied" };
    return {
      outcome: "applied",
      appliedRef: {
        counts: {
          created: documents.filter((document) => document.action === "create").length,
          replaced: documents.filter((document) => document.action === "replace").length,
          unchanged: documents.filter((document) => document.action === "unchanged").length,
          failed: 0,
        },
        failures: [],
        reconciled: true,
      },
    };
  }

  /** Recomputes a reviewed plan's fence from document-owned state. */
  async readReviewedPlanFence(input: {
    readonly workspaceId: string;
    readonly targetRef: DocumentReviewedOperationTargetRef;
    readonly plan: DocumentReviewedOperationPlan;
  }): Promise<string> {
    if (input.plan.operation === "import") {
      const states = await Promise.all(input.plan.documents.map(async (document) => ({ document, state: (await this.resolveImportPageState(input.workspaceId, input.targetRef.sourceId, document.externalDocumentId)).state })));
      const valid = states.every(({ document, state }) => {
        const pending = (state?.documentId ?? null) === document.expectedDocumentId && (state?.revision ?? null) === document.expectedRevision && (state?.contentHash ?? null) === document.expectedContentHash;
        return pending || state?.contentHash === document.contentHash;
      });
      return valid ? input.plan.fence : "changed";
    }
    const documents = input.plan.documents;
    const current = await this.documents.listSummariesByIdsAndWorkspaceId(input.workspaceId, documents.map((document) => document.id));
    const byId = new Map(current.map((document) => [document.id, document]));
    const valid = input.plan.operation === "removal"
      ? documents.every((document) => { const row = byId.get(document.id); return !row || row.updatedAt.toISOString() === document.updatedAt; })
      : documents.every((document) => { const row = byId.get(document.id); return row && (row.updatedAt.toISOString() === document.updatedAt || row.status === "queued" || row.status === "processing"); });
    return valid ? input.plan.fence : "changed";
  }

  async resolveRemoval(input: { readonly workspaceId: string; readonly documentIds: readonly string[] }): Promise<{
    readonly found: readonly { id: string; title: string; updatedAt: Date }[];
    readonly unknownIds: readonly string[];
  }> {
    const documents = await this.documents.listSummariesByIdsAndWorkspaceId(input.workspaceId, [...input.documentIds]);
    const found = documents.map((document) => ({ id: document.id, title: document.title, updatedAt: document.updatedAt }));
    const known = new Set(found.map((document) => document.id));
    return { found, unknownIds: input.documentIds.filter((id) => !known.has(id)) };
  }

  async resolveRemovalByExternalIds(input: { readonly workspaceId: string; readonly sourceId: string | null; readonly externalDocumentIds: readonly string[] }): Promise<{
    readonly found: readonly { id: string; title: string; updatedAt: Date }[];
    readonly unknownIds: readonly string[];
  }> {
    const resolved = await Promise.all(input.externalDocumentIds.map(async (externalDocumentId) => {
      const document = input.sourceId
        ? await this.documents.findBySourceAndExternalDocumentId(input.workspaceId, input.sourceId, externalDocumentId)
        : await this.documents.findByExternalDocumentId(input.workspaceId, externalDocumentId);
      return { externalDocumentId, document };
    }));
    return {
      found: resolved.flatMap(({ document }) => document ? [{ id: document.id, title: document.title, updatedAt: document.updatedAt }] : []),
      unknownIds: resolved.flatMap(({ externalDocumentId, document }) => document ? [] : [externalDocumentId]),
    };
  }

  async prepareRemoval(input: { readonly workspaceId: string; readonly documentIds: readonly string[]; readonly externalDocumentIds: readonly string[]; readonly sourceId: string | null }): Promise<DocumentReviewedRemovalPlan> {
    if (input.externalDocumentIds.length > 0 && !input.sourceId) throw badRequest("sourceId is required when externalDocumentIds are supplied.");
    const [byId, byExternal] = await Promise.all([
      this.resolveRemoval({ workspaceId: input.workspaceId, documentIds: input.documentIds }),
      this.resolveRemovalByExternalIds({ workspaceId: input.workspaceId, sourceId: input.sourceId, externalDocumentIds: input.externalDocumentIds }),
    ]);
    const documents = [...new Map([...byId.found, ...byExternal.found].map((document) => [document.id, { ...document, updatedAt: document.updatedAt.toISOString() }])).values()];
    const unknownIds = [...byId.unknownIds, ...byExternal.unknownIds];
    if (documents.length === 0) throw badRequest("No documents match this reviewed removal selector.");
    return this.parsePlan(documentReviewedRemovalPlanSchema, { operation: "removal", documents, unknownIds, fence: createHash("sha256").update(JSON.stringify(documents.map(({ id, updatedAt }) => ({ id, updatedAt })))).digest("base64url") });
  }

  async remove(input: { readonly workspaceId: string; readonly documents: readonly { id: string; updatedAt: string }[] }): Promise<{
    readonly counts: Record<"removed" | "changed" | "alreadyRemoved" | "failed", number>;
    readonly failures: readonly { documentId: string; code: string }[];
  }> {
    const counts = { removed: 0, changed: 0, alreadyRemoved: 0, failed: 0 };
    const failures: { documentId: string; code: string }[] = [];
    for (const document of input.documents) {
      try {
        await this.deletion.delete({ workspaceId: input.workspaceId, documentId: document.id, expectedUpdatedAt: new Date(document.updatedAt) });
        counts.removed += 1;
      } catch (error) {
        if (error instanceof AppError && error.code === "conflict") counts.changed += 1;
        else if (error instanceof AppError && error.code === "not_found") counts.alreadyRemoved += 1;
        else {
          counts.failed += 1;
          failures.push({ documentId: document.id, code: error instanceof AppError ? error.code : "internal_error" });
        }
      }
    }
    return { counts, failures };
  }

  async reprocess(input: { readonly workspaceId: string; readonly kind: "documents" | "source" | "all"; readonly documentIds?: readonly string[]; readonly documents?: readonly { id: string; updatedAt: string }[]; readonly sourceId?: string | null }): Promise<{
    readonly queued: number;
    readonly skipped: number;
    readonly failed: number;
  }> {
    if (input.kind === "source") {
      if (!this.sourceReprocess) throw badRequest("Source reprocessing is not configured.");
      const result = await this.sourceReprocess.reprocessSource({ workspaceId: input.workspaceId, sourceId: input.sourceId ?? null });
      return { queued: result.queuedDocumentCount, skipped: result.skippedDocumentCount, failed: 0 };
    }
    if (input.kind === "all") {
      if (!this.workspaceReprocess) throw badRequest("Workspace reprocessing is not configured.");
      const result = await this.workspaceReprocess.reprocessWorkspace(input.workspaceId);
      return { queued: result.queuedDocumentCount, skipped: result.skippedDocumentCount, failed: 0 };
    }
    const expected = new Map((input.documents ?? []).map((document) => [document.id, document.updatedAt]));
    let queued = 0; let skipped = 0; let failed = 0;
    for (const documentId of input.documentIds ?? []) {
      try {
        const updatedAt = expected.get(documentId);
        const result = await this.ingestion.reprocessEligible({ workspaceId: input.workspaceId, documentId, ...(updatedAt ? { expectedUpdatedAt: new Date(updatedAt) } : {}) });
        queued += result.queuedDocumentCount; skipped += result.skippedDocumentCount;
      } catch { failed += 1; }
    }
    return { queued, skipped, failed };
  }

  async previewReprocess(input: { readonly workspaceId: string; readonly kind: "documents" | "source" | "all"; readonly documentIds?: readonly string[]; readonly sourceId?: string | null }) {
    return this.documents.countReprocessCandidates({ workspaceId: input.workspaceId, ...(input.kind === "documents" ? { documentIds: input.documentIds ?? [] } : input.kind === "source" ? { sourceId: input.sourceId ?? null } : {}) });
  }

  async prepareReprocess(input: { readonly workspaceId: string; readonly kind: "documents" | "source" | "all"; readonly documentIds?: readonly string[]; readonly sourceId?: string | null }): Promise<DocumentReviewedReprocessPlan> {
    const page = input.kind === "documents"
      ? { documents: await this.documents.listSummariesByIdsAndWorkspaceId(input.workspaceId, [...(input.documentIds ?? [])]), hasMore: false }
      : input.kind === "source"
        ? await this.documents.listSummaryPageBySourceId(input.workspaceId, input.sourceId ?? null, { limit: 200 })
        : await this.documents.listSummaryPageByWorkspaceId(input.workspaceId, { limit: 200 });
    if (page.hasMore) throw badRequest("A reviewed reprocess may include at most 200 documents. Select a source or explicit document ids.");
    if (page.documents.length === 0) throw badRequest("No documents match this reviewed reprocess selector.");
    const documents = page.documents.map((document) => ({ id: document.id, updatedAt: document.updatedAt.toISOString(), status: document.status }));
    return this.parsePlan(documentReviewedReprocessPlanSchema, { operation: "reprocess", documents, fence: createHash("sha256").update(JSON.stringify(documents.map(({ id, updatedAt }) => ({ id, updatedAt })))).digest("base64url") });
  }

  /** Applies the Documents-owned persisted plan without exposing its fields to a transport adapter. */
  async applyReviewedPlan(input: { readonly workspaceId: string; readonly accountId: string; readonly targetRef: DocumentReviewedOperationTargetRef; readonly plan: DocumentReviewedOperationPlan }) {
    if (input.plan.operation === "removal") {
      const result = await this.remove({ workspaceId: input.workspaceId, documents: input.plan.documents });
      return { outcome: "applied" as const, appliedRef: result, ...(result.counts.failed > 0 ? { reason: "partial_failure" } : {}) };
    }
    if (input.plan.operation === "reprocess") {
      const result = await this.reprocess({ workspaceId: input.workspaceId, kind: "documents", documentIds: input.plan.documents.map((document) => document.id), documents: input.plan.documents });
      return { outcome: "applied" as const, appliedRef: result, ...(result.failed > 0 ? { reason: "partial_failure" } : {}) };
    }
    const result = await this.import({ workspaceId: input.workspaceId, accountId: input.accountId, sourceId: input.targetRef.sourceId, documents: input.plan.documents });
    return { outcome: "applied" as const, appliedRef: result, ...(result.counts.failed > 0 ? { reason: "partial_failure" } : {}) };
  }

  /** Active rows shortcut normal ingestion; failed rows still own the reviewed-write fence. */
  private async resolveImportPageState(workspaceId: string, sourceId: string | null, externalDocumentId: string) {
    const active = await this.documents.findActivePageState({ workspaceId, sourceId, externalDocumentId });
    return { active, state: active ?? await this.documents.findPageState({ workspaceId, sourceId, externalDocumentId }) };
  }

  /**
   * Every reviewed plan this owner returns is bounded by its persisted schema, so an over-limit
   * or otherwise malformed plan is a caller refusal, not an unhandled parse error a transport
   * would report as an outage.
   */
  private parsePlan<Schema extends z.ZodTypeAny>(schema: Schema, value: unknown): z.infer<Schema> {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw badRequest(`This reviewed operation exceeds what Documents will persist: ${result.error.issues[0]?.message ?? "invalid plan"}.`);
  }
}
