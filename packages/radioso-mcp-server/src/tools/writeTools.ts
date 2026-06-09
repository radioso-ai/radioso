import { z } from "zod";

import type { GenericToolDefinition } from "./common.js";
import { metadataRecordSchema } from "./common.js";

const createDocumentSchema = z.object({
  content: z.string().min(1),
  externalDocumentId: z.string().trim().min(1).optional(),
  metadata: metadataRecordSchema.optional(),
  title: z.string().min(1),
});

const updateDocumentSchema = createDocumentSchema.extend({
  documentId: z.string().min(1),
});

const documentIdSchema = z.object({
  documentId: z.string().min(1),
});

export const createWriteToolDefinitions = (): GenericToolDefinition[] => [
  {
    accessMode: "write",
    description: "Create a new workspace document.",
    execute: async (args: unknown, context) => {
      const parsed = createDocumentSchema.parse(args);
      const data = await context.adapter.createDocument({
        content: parsed.content,
        externalDocumentId: parsed.externalDocumentId,
        metadata: parsed.metadata,
        title: parsed.title,
      });
      return {
        data,
        summary: `Document "${parsed.title}" created.`,
      };
    },
    inputSchema: createDocumentSchema,
    name: "create_document",
    requiresApproval: true,
  },
  {
    accessMode: "write",
    description: "Update an existing workspace document.",
    execute: async (args: unknown, context) => {
      const parsed = updateDocumentSchema.parse(args);
      const data = await context.adapter.updateDocument(parsed.documentId, {
        content: parsed.content,
        externalDocumentId: parsed.externalDocumentId,
        metadata: parsed.metadata,
        title: parsed.title,
      });
      return {
        data,
        summary: `Document ${parsed.documentId} updated.`,
      };
    },
    inputSchema: updateDocumentSchema,
    name: "update_document",
    requiresApproval: true,
  },
  {
    accessMode: "write",
    description: "Delete an existing workspace document.",
    execute: async (args: unknown, context) => {
      const parsed = documentIdSchema.parse(args);
      await context.adapter.deleteDocument(parsed.documentId);
      return {
        data: { deleted: true, documentId: parsed.documentId },
        summary: `Document ${parsed.documentId} deleted.`,
      };
    },
    inputSchema: documentIdSchema,
    name: "delete_document",
    requiresApproval: true,
  },
  {
    accessMode: "write",
    description: "Queue an existing workspace document for reprocessing.",
    execute: async (args: unknown, context) => {
      const parsed = documentIdSchema.parse(args);
      const data = await context.adapter.reprocessDocument(parsed.documentId);
      return {
        data,
        summary: `Document ${parsed.documentId} queued for reprocessing.`,
      };
    },
    inputSchema: documentIdSchema,
    name: "reprocess_document",
    requiresApproval: true,
  },
];
