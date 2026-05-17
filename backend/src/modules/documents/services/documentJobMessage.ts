import { z } from "zod";

import type { DocumentJobDispatchRequest } from "./documentJobDispatcher.js";

export const documentJobQueueMessageSchema = z.object({
  jobId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  revision: z.number().int().positive().optional(),
}).strict();

export type DocumentJobQueueMessage = z.infer<typeof documentJobQueueMessageSchema>;

export const toDocumentJobQueueMessage = (input: DocumentJobDispatchRequest): DocumentJobQueueMessage => ({
  jobId: input.jobId,
  documentId: input.documentId,
  workspaceId: input.workspaceId,
  revision: input.revision,
});

export const parseDocumentJobQueueMessage = (input: unknown): DocumentJobQueueMessage =>
  documentJobQueueMessageSchema.parse(input);
