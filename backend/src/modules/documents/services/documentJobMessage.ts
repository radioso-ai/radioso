import { z } from "zod";

import type { DocumentJobDispatchRequest } from "./documentJobDispatcher.js";

export const documentJobQueueMessageSchema = z.object({
  jobId: z.string().uuid(),
}).strict();

export type DocumentJobQueueMessage = z.infer<typeof documentJobQueueMessageSchema>;

export const toDocumentJobQueueMessage = (input: DocumentJobDispatchRequest): DocumentJobQueueMessage => ({
  jobId: input.jobId,
});

export const parseDocumentJobQueueMessage = (input: unknown): DocumentJobQueueMessage =>
  documentJobQueueMessageSchema.parse(input);
