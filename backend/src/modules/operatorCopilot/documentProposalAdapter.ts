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
import { badRequest } from "../../shared/domain/errors.js";

/**
 * A create addresses no stored row, and it carries no external identity that could collide with
 * one, so there is no version for it to be stale against. A constant states that plainly instead of
 * borrowing an unrelated row's timestamp.
 */
const CREATE_VERSION_TOKEN = "create";

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
  title: document.title,
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
          targetLabel: payload.title,
          current: null,
          proposed: { title: payload.title, content: payload.content, metadata: payload.metadata ?? {} },
        };
      }
      // A missing document still previews: the operator is looking at a card for something that has
      // since been deleted, and an empty current is the honest rendering of that.
      const document = await readDocument(workspaceId, requiredDocumentId(targetRef)).catch(() => null);
      if (payload.op === "delete") {
        return { targetLabel: document?.title ?? payload.title, current: document ? retrievalState(document) : null, proposed: null };
      }
      return {
        targetLabel: document?.title ?? payload.title,
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
            title: payload.title,
            content: payload.content,
            ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
          });
          return { outcome: "applied" as const, appliedRef: { documentId: created.documentId } };
        }

        const documentId = requiredDocumentId(targetRef);
        // The documents service takes no expected-version argument, so the version check is this
        // read compared against the draft's token. The window it leaves open is the one apply call.
        const document = await readDocument(workspaceId, documentId).catch(() => null);
        if (!document || versionToken(document) !== token) return { outcome: "stale" as const };

        if (payload.op === "delete") {
          await deps.documentDeletion.delete({ workspaceId, documentId });
          return { outcome: "applied" as const, appliedRef: { documentId } };
        }

        // Metadata is replaced first so the requeue it triggers carries the new tags, matching the
        // order the documents PATCH route settles the same two writes in.
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
        payload: copilotDocumentPayloadSchema.parse({ ...change, title: document.title }),
        versionToken: versionToken(document),
      };
    },
  };
};
