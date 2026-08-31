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
  readonly documentDeletion: CopilotDocumentDeletionPort;
  readonly workspaceAccount: CopilotWorkspaceAccountResolver;
}

const requiredDocumentId = (targetRef: { documentId: string | null }): string => {
  if (!targetRef.documentId) throw badRequest("This document change must name the document it changes");
  return targetRef.documentId;
};

const versionToken = (document: Pick<CopilotDocumentSummary, "updatedAt">): string =>
  document.updatedAt.toISOString();

const retrievalState = (document: CopilotDocumentSummary) => ({
  name: document.title,
  metadata: document.metadata,
  retrievalEnabled: document.retrievalEnabled,
  retrievalExpiresAt: document.retrievalExpiresAt ? document.retrievalExpiresAt.toISOString() : null,
});

const proposedRetrievalState = (
  document: CopilotDocumentSummary,
  payload: Extract<CopilotDocumentPayload, { op: "update_retrieval" }>,
) => {
  const current = retrievalState(document);
  return {
    ...current,
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(payload.retrievalEnabled !== undefined ? { retrievalEnabled: payload.retrievalEnabled } : {}),
    ...(payload.retrievalExpiresAt !== undefined ? { retrievalExpiresAt: payload.retrievalExpiresAt } : {}),
  };
};

export const createDocumentCopilotProposalAdapter = (
  deps: DocumentCopilotProposalAdapterDependencies,
): CopilotDocumentProposalAdapter => {
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
      return versionToken(await readDocument(workspaceId, targetRef.documentId));
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
        proposed: document ? proposedRetrievalState(document, payload) : null,
      };
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
        // The documents service takes no expected-version argument, so the version check is this
        // read compared against the draft's token, leaving a window between them. That is the same
        // window the dashboard's own save has, so applying a proposal is no less safe than the edit
        // it mirrors - but neither is atomic. Conditional writes are tracked separately.
        const document = await readOrMissing(readDocument(workspaceId, documentId));
        if (!document || versionToken(document) !== token) return { outcome: "stale" as const };

        if (payload.op === "delete") {
          await deps.documentDeletion.delete({ workspaceId, documentId });
          return { outcome: "applied" as const, appliedRef: { documentId } };
        }

        // Metadata is replaced first so the requeue it triggers carries the new tags, matching the
        // order the documents PATCH route settles the same two writes in. They are two writes, so a
        // failure in the second leaves the first applied while the proposal reports `failed` - again
        // matching the route, which has no transaction around the pair either.
        if (payload.metadata !== undefined) {
          await deps.documentAuthoring.updateMetadata({ workspaceId, documentId, metadata: payload.metadata });
        }
        if (payload.retrievalEnabled !== undefined || payload.retrievalExpiresAt !== undefined) {
          await deps.documentAuthoring.updateRetrievalEligibility({
            workspaceId,
            documentId,
            ...(payload.retrievalEnabled !== undefined ? { retrievalEnabled: payload.retrievalEnabled } : {}),
            ...(payload.retrievalExpiresAt !== undefined
              ? { retrievalExpiresAt: payload.retrievalExpiresAt === null ? null : new Date(payload.retrievalExpiresAt) }
              : {}),
          });
        }
        return { outcome: "applied" as const, appliedRef: { documentId } };
      } catch (error) {
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
        versionToken: versionToken(document),
      };
    },
  };
};
