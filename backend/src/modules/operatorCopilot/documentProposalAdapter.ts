import {
  copilotDocumentChangeSchema,
  copilotDocumentPayloadSchema,
  copilotDocumentTargetRefSchema,
  type CopilotDocumentAuthoringPort,
  type CopilotDocumentDeletionPort,
  type CopilotDocumentPayload,
  type CopilotDocumentSummary,
  type CopilotWorkspaceAccountResolver,
} from "./contracts/documentAuthoring.js";
import type { CopilotDocumentProposalAdapter } from "./contracts.js";
import { isStale, versionInstant, versionToken } from "./proposalVersioning.js";
import { AppError, badRequest } from "../../shared/domain/errors.js";

/**
 * A create addresses no stored row, and it carries no external identity that could collide with
 * one, so there is no version for it to be stale against. A constant states that plainly instead of
 * borrowing an unrelated row's timestamp.
 */
const CREATE_VERSION_TOKEN = "create";

/**
 * Only a target that is genuinely gone reads as gone. A database or service failure that also threw
 * would otherwise be reported as "someone deleted this" - resolving a proposal an operator could
 * have retried, and telling them a conflict happened that did not.
 */
const missingTarget = (error: unknown): boolean => error instanceof AppError && error.code === "not_found";
const readOrMissing = async <T>(read: Promise<T>): Promise<T | null> => {
  try {
    return await read;
  } catch (error) {
    if (missingTarget(error)) return null;
    throw error;
  }
};

export interface DocumentCopilotProposalAdapterDependencies {
  readonly documentAuthoring: CopilotDocumentAuthoringPort;
  /** Injected so a preview's expiry reasoning is testable rather than clock-dependent. */
  readonly now?: () => Date;
  readonly documentDeletion: CopilotDocumentDeletionPort;
  readonly workspaceAccount: CopilotWorkspaceAccountResolver;
}

const requiredDocumentId = (targetRef: { documentId: string | null }): string => {
  if (!targetRef.documentId) throw badRequest("This document change must name the document it changes");
  return targetRef.documentId;
};

const retrievalState = (document: CopilotDocumentSummary) => ({
  name: document.title,
  metadata: document.metadata,
  retrievalEnabled: document.retrievalEnabled,
  retrievalExpiresAt: document.retrievalExpiresAt ? document.retrievalExpiresAt.toISOString() : null,
});

const proposedRetrievalState = (
  document: CopilotDocumentSummary,
  payload: Extract<CopilotDocumentPayload, { op: "update_retrieval" }>,
  now: Date,
) => {
  const current = retrievalState(document);
  const proposed = {
    ...current,
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(payload.retrievalEnabled !== undefined ? { retrievalEnabled: payload.retrievalEnabled } : {}),
    ...(payload.retrievalExpiresAt !== undefined ? { retrievalExpiresAt: payload.retrievalExpiresAt } : {}),
  };
  // The write clears an expiry already in the past when retrieval is being switched on, so showing
  // the requested date would promise an eligibility window the document will not come back with.
  const expiresAt = proposed.retrievalExpiresAt;
  if (payload.retrievalEnabled === true && expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime()) {
    return { ...proposed, retrievalExpiresAt: null };
  }
  return proposed;
};

export const createDocumentCopilotProposalAdapter = (
  deps: DocumentCopilotProposalAdapterDependencies,
): CopilotDocumentProposalAdapter => {
  const now = deps.now ?? (() => new Date());
  const readDocument = (workspaceId: string, documentId: string) =>
    deps.documentAuthoring.getDocument(workspaceId, documentId);

  return {
    targetType: "document",

    async readVersionToken(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = copilotDocumentTargetRefSchema.parse(rawTargetRef);
      if (rawPayload !== undefined && copilotDocumentPayloadSchema.parse(rawPayload).op === "create") {
        return CREATE_VERSION_TOKEN;
      }
      if (!targetRef.documentId) return CREATE_VERSION_TOKEN;
      return versionToken((await readDocument(workspaceId, targetRef.documentId)).updatedAt);
    },

    async preview(workspaceId, rawTargetRef, rawPayload) {
      const targetRef = copilotDocumentTargetRefSchema.parse(rawTargetRef);
      const payload = copilotDocumentPayloadSchema.parse(rawPayload);
      if (payload.op === "create") {
        return {
          targetLabel: payload.name,
          current: null,
          proposed: { name: payload.name, content: payload.content, metadata: payload.metadata ?? {} },
        };
      }
      // A missing document still previews: the operator is looking at a card for something that has
      // since been deleted, and an empty current is the honest rendering of that.
      const document = await readOrMissing(readDocument(workspaceId, requiredDocumentId(targetRef)));
      if (payload.op === "delete") {
        return { targetLabel: document?.title ?? payload.name, current: document ? retrievalState(document) : null, proposed: null };
      }
      return {
        targetLabel: document?.title ?? payload.name,
        current: document ? retrievalState(document) : null,
        proposed: document ? proposedRetrievalState(document, payload, now()) : null,
      };
    },

    canRetryAfterInterruptedApply(rawTargetRef, rawPayload) {
      copilotDocumentTargetRefSchema.parse(rawTargetRef);
      // A create's token is the constant `"create"`: nothing about the workspace after a first
      // attempt says the document is already there, so a retry would ingest a second one and
      // reserve a second document and storage quota against it.
      return copilotDocumentPayloadSchema.parse(rawPayload).op !== "create";
    },

    async applyIfVersionMatches(workspaceId, rawTargetRef, rawPayload, token) {
      const targetRef = copilotDocumentTargetRefSchema.parse(rawTargetRef);
      const payload = copilotDocumentPayloadSchema.parse(rawPayload);
      try {
        if (payload.op === "create") {
          const created = await deps.documentAuthoring.ingest({
            workspaceId,
            accountId: await deps.workspaceAccount.resolveAccountId(workspaceId),
            title: payload.name,
            content: payload.content,
            ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
          });
          return { outcome: "applied" as const, appliedRef: { documentId: created.documentId } };
        }

        const documentId = requiredDocumentId(targetRef);
        // The draft's token goes into the write's own predicate rather than being compared against
        // a read here: the documents service refuses a row that moved, so there is no window
        // between checking the version and writing over it. A refusal comes back as `conflict`,
        // which is this adapter's `stale`.
        // A token that names no instant cannot describe the row this write has to match, which is
        // the same answer to the operator as a version that moved.
        const expectedUpdatedAt = versionInstant(token);
        if (!expectedUpdatedAt) return { outcome: "stale" as const };

        if (payload.op === "delete") {
          await deps.documentDeletion.delete({ workspaceId, documentId, expectedUpdatedAt });
          return { outcome: "applied" as const, appliedRef: { documentId } };
        }

        // Metadata and eligibility settle in one call, so a proposal that named both can no longer
        // land half of it and report that the whole change failed.
        await deps.documentAuthoring.updateRetrievalSettings({
          workspaceId,
          documentId,
          expectedUpdatedAt,
          ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
          ...(payload.retrievalEnabled !== undefined ? { retrievalEnabled: payload.retrievalEnabled } : {}),
          ...(payload.retrievalExpiresAt !== undefined
            ? { retrievalExpiresAt: payload.retrievalExpiresAt === null ? null : new Date(payload.retrievalExpiresAt) }
            : {}),
        });
        return { outcome: "applied" as const, appliedRef: { documentId } };
      } catch (error) {
        // Only a change to a stored document can be stale. A create addresses no row, so a refusal
        // there is a genuine failure however the owning service phrased it.
        if (payload.op !== "create" && isStale(error)) return { outcome: "stale" as const };
        return { outcome: "failed" as const, reason: error instanceof Error ? error.message : "Document change apply failed" };
      }
    },

    async validatePayload(workspaceId, rawTargetRef, rawChange) {
      const targetRef = copilotDocumentTargetRefSchema.parse(rawTargetRef);
      const change = copilotDocumentChangeSchema.parse(rawChange);
      if (change.op === "create") {
        return { targetRef: { documentId: null }, payload: change, versionToken: CREATE_VERSION_TOKEN };
      }
      if (change.op === "update_retrieval"
        && change.retrievalEnabled === undefined
        && change.retrievalExpiresAt === undefined
        && change.metadata === undefined) {
        throw badRequest("Provide retrievalEnabled, retrievalExpiresAt and/or metadata");
      }
      // The token comes from this same read rather than a follow-up readVersionToken call, so the
      // title the card names and the version Apply checks describe one observed state.
      const document = await readDocument(workspaceId, requiredDocumentId(targetRef));
      return {
        targetRef: { documentId: document.id },
        payload: copilotDocumentPayloadSchema.parse({ ...change, name: document.title }),
        versionToken: versionToken(document.updatedAt),
      };
    },
  };
};
