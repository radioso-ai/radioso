import { z, type ZodType } from "zod";

import { documentMetadataRecordSchema } from "../../documents/public.js";
import {
  MAX_COPILOT_DOCUMENT_CONTENT,
  type CopilotDocumentChange,
  type CopilotDocumentPayload,
} from "../contracts/documentAuthoring.js";
import type { CopilotDocumentProposalAdapter, CopilotToolDescriptor } from "../contracts.js";
import { requireCurrentCopilotPermissions } from "../authorization.js";
import {
  entity,
  proposalAdapterFor,
  proposalOutputSchema,
  recordProposalCreated,
  requiredCopilotConversation,
  type CopilotProposalToolDependencies,
} from "./shared.js";

const documentIdSchema = z.string().uuid();
const rationaleSchema = z.string().trim().min(1).max(1_000).optional();
const MANAGE_DOCUMENTS = ["workspace.documents.manage"] as const;

const createInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(MAX_COPILOT_DOCUMENT_CONTENT),
  metadata: documentMetadataRecordSchema.optional(),
  rationale: rationaleSchema,
}).strict();

const retrievalInputSchema = z.object({
  documentId: documentIdSchema,
  retrievalEnabled: z.boolean().optional(),
  retrievalExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  metadata: documentMetadataRecordSchema.optional(),
  rationale: rationaleSchema,
}).strict();

const removalInputSchema = z.object({
  documentId: documentIdSchema,
  rationale: rationaleSchema,
}).strict();

export type DocumentProposalCopilotToolDependencies = CopilotProposalToolDependencies;

/** What a tool contributes beyond persisting the draft: the payload it proposes and how it reads. */
interface DocumentProposalSpec<TInput> {
  readonly name: string;
  readonly uiLabel: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly targetDocumentId: (input: TInput) => string | null;
  readonly change: (input: TInput) => CopilotDocumentChange;
  readonly summary: (targetLabel: string, input: TInput) => string;
  /** Set only where applying the proposal deletes its target. */
  readonly removal?: true;
}

const withRationale = (summary: string, rationale: string | undefined): string =>
  rationale ? `${summary} ${rationale}` : summary;

const describeChange = (input: z.infer<typeof retrievalInputSchema>): string => {
  const changes: string[] = [];
  if (input.retrievalEnabled !== undefined) {
    changes.push(input.retrievalEnabled ? "make it retrievable again" : "stop it being retrieved");
  }
  if (input.retrievalExpiresAt !== undefined) {
    changes.push(input.retrievalExpiresAt === null ? "clear its retrieval expiry" : `expire it from retrieval on ${input.retrievalExpiresAt}`);
  }
  if (input.metadata !== undefined) changes.push("replace its metadata");
  return changes.join(", ");
};

const documentProposalDescriptor = <TInput>(
  deps: DocumentProposalCopilotToolDependencies,
  adapter: CopilotDocumentProposalAdapter,
  spec: DocumentProposalSpec<TInput>,
): CopilotToolDescriptor => {
  const shared = {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: proposalOutputSchema,
  };
  return {
    ...shared,
    shape: "propose",
    uiLabel: spec.uiLabel,
    contributingModule: "documents",
    dashboardSubject: { type: "proposal" },
    requiredPermissions: [...MANAGE_DOCUMENTS] as unknown as CopilotToolDescriptor["requiredPermissions"],
    createTool: (context) => ({
      ...shared,
      invoke: async (input: TInput) => {
        await requireCurrentCopilotPermissions(context, [...MANAGE_DOCUMENTS]);
        // validatePayload is the version-token source and, for a change addressing a stored
        // document, the existence check: it throws rather than drafting against nothing.
        const validated = await adapter.validatePayload(
          context.workspaceId,
          { documentId: spec.targetDocumentId(input) },
          spec.change(input),
        );
        const payload = validated.payload as CopilotDocumentPayload;
        const summary = spec.summary(payload.name, input);
        await requireCurrentCopilotPermissions(context, [...MANAGE_DOCUMENTS]);
        const proposal = await deps.proposalRepository.createProposal({
          workspaceId: context.workspaceId,
          operatorUserId: context.operatorUserId,
          conversationId: requiredCopilotConversation(context),
          targetType: "document",
          targetRef: validated.targetRef,
          payload: { ...payload, summary },
          versionToken: validated.versionToken,
          // A document change installs through no agent config override, so no replay can measure
          // it. Citing evidence is refused by omission rather than resolved and discarded.
          evidence: null,
        });
        await recordProposalCreated(deps.auditService, context, proposal);
        return {
          proposalId: proposal.id,
          targetType: "document" as const,
          targetLabel: payload.name,
          summary,
          ...(spec.removal ? { removal: true as const } : {}),
        };
      },
    }),
    describeEntity: (input) => entity("document", spec.targetDocumentId(input as TInput)),
  } as CopilotToolDescriptor;
};

export const createDocumentProposalCopilotTools = (
  deps: DocumentProposalCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor> => {
  const adapter = proposalAdapterFor(deps.proposalAdapters, "document");
  return [
    documentProposalDescriptor(deps, adapter, {
      name: "propose_document",
      uiLabel: "Drafting a document",
      description: "Propose a new workspace knowledge document for the operator to review and apply. Write the whole document body; it is stored exactly as drafted. Use this to close a knowledge gap a turn exposed, not to restate something an existing document already covers.",
      inputSchema: createInputSchema,
      targetDocumentId: () => null,
      change: (input) => ({
        op: "create",
        name: input.title,
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
        content: input.content,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }),
      summary: (targetLabel, input) => withRationale(`Add the document "${targetLabel}".`, input.rationale),
    }),
    documentProposalDescriptor(deps, adapter, {
      name: "propose_document_retrieval",
      uiLabel: "Drafting a document retrieval change",
      description: "Propose changing whether an existing document is retrievable, when its eligibility expires, and the metadata retrieval filters on. Reversible, and it does not touch the document's text — there is no tool for rewriting a document body, because you only ever see snippets and chunks of one.",
      inputSchema: retrievalInputSchema,
      targetDocumentId: (input) => input.documentId,
      change: (input) => ({
        op: "update_retrieval",
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
        ...(input.retrievalEnabled !== undefined ? { retrievalEnabled: input.retrievalEnabled } : {}),
        ...(input.retrievalExpiresAt !== undefined ? { retrievalExpiresAt: input.retrievalExpiresAt } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }),
      summary: (targetLabel, input) => withRationale(`For the document "${targetLabel}", ${describeChange(input)}.`, input.rationale),
    }),
    documentProposalDescriptor(deps, adapter, {
      name: "propose_document_removal",
      uiLabel: "Proposing document removal",
      description: "Propose permanently deleting a document and everything indexed from it. If the goal is only to keep it out of answers, use propose_document_retrieval with retrievalEnabled: false instead: that is reversible and preserves the text. Applying removal cannot be undone.",
      inputSchema: removalInputSchema,
      targetDocumentId: (input) => input.documentId,
      change: (input) => ({ op: "delete", removesTarget: true, ...(input.rationale !== undefined ? { rationale: input.rationale } : {}) }),
      summary: (targetLabel, input) => withRationale(`Permanently remove the document "${targetLabel}". This cannot be undone.`, input.rationale),
      removal: true,
    }),
  ];
};
