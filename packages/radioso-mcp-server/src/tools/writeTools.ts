import { z } from "zod";

import type { RadiosoApiAdapter } from "../radiosoApiAdapter.js";
import type { GenericToolDefinition } from "./common.js";
import { metadataRecordSchema, retrievalPatchSchema } from "./common.js";

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

export const createWriteToolDefinitions = (adapter: RadiosoApiAdapter): GenericToolDefinition[] => [
  {
    description: "Create a new workspace document.",
    execute: async (args: unknown) => {
      const parsed = createDocumentSchema.parse(args);
      const data = await adapter.createDocument(parsed);
      return {
        data,
        summary: `Document "${parsed.title}" created.`,
      };
    },
    inputSchema: createDocumentSchema,
    name: "create_document",
  },
  {
    description: "Update an existing workspace document.",
    execute: async (args: unknown) => {
      const parsed = updateDocumentSchema.parse(args);
      const data = await adapter.updateDocument(parsed.documentId, {
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
  },
  {
    description: "Delete an existing workspace document.",
    execute: async (args: unknown) => {
      const parsed = documentIdSchema.parse(args);
      await adapter.deleteDocument(parsed.documentId);
      return {
        data: { deleted: true, documentId: parsed.documentId },
        summary: `Document ${parsed.documentId} deleted.`,
      };
    },
    inputSchema: documentIdSchema,
    name: "delete_document",
  },
  {
    description: "Queue an existing workspace document for reprocessing.",
    execute: async (args: unknown) => {
      const parsed = documentIdSchema.parse(args);
      const data = await adapter.reprocessDocument(parsed.documentId);
      return {
        data,
        summary: `Document ${parsed.documentId} queued for reprocessing.`,
      };
    },
    inputSchema: documentIdSchema,
    name: "reprocess_document",
  },
  {
    description: "Apply a partial patch to workspace retrieval settings by merging it with the current settings.",
    execute: async (args: unknown) => {
      const patch = retrievalPatchSchema.parse(args);
      const current = await adapter.getRetrievalSettings();
      const merged = {
        ...current,
        ...patch,
      };
      const data = await adapter.updateRetrievalSettings(merged);
      return {
        data,
        summary: "Workspace retrieval settings updated.",
      };
    },
    inputSchema: retrievalPatchSchema,
    name: "update_retrieval_settings",
  },
];
