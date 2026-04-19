import { z } from "zod";

import type { RadiosoApiAdapter } from "../radiosoApiAdapter.js";
import type { GenericToolDefinition } from "./common.js";
import { metadataRecordSchema } from "./common.js";

const emptySchema = z.object({});
const listDocumentsSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});
const getDocumentSchema = z.object({
  documentId: z.string().min(1),
});
const searchDocumentsSchema = z.object({
  metadataFilter: metadataRecordSchema.optional(),
  query: z.string().min(1),
});
const answerGroundedSchema = z.object({
  conversationId: z.string().uuid().optional(),
  metadataFilter: z.record(z.string(), z.unknown()).optional(),
  query: z.string().min(1),
});

const capabilityNames = {
  readTools: [
    "describe_capabilities",
    "list_documents",
    "get_document",
    "search_documents",
    "answer_grounded",
    "get_retrieval_settings",
  ],
  writeTools: [
    "create_document",
    "update_document",
    "delete_document",
    "reprocess_document",
    "update_retrieval_settings",
  ],
};

export const createReadToolDefinitions = (adapter: RadiosoApiAdapter): GenericToolDefinition[] => [
  {
    description: "Describe the read and write tools available from this Radioso MCP server.",
    execute: async () => ({
      data: capabilityNames,
      summary: "Available Radioso MCP capabilities returned.",
    }),
    inputSchema: emptySchema,
    name: "describe_capabilities",
  },
  {
    description: "List workspace documents visible to the configured Radioso API token.",
    execute: async (args: unknown) => {
      const parsed = listDocumentsSchema.parse(args);
      const data = await adapter.listDocuments(parsed);
      return {
        data,
        summary: "Workspace documents returned.",
      };
    },
    inputSchema: listDocumentsSchema,
    name: "list_documents",
  },
  {
    description: "Fetch one workspace document by ID.",
    execute: async (args: unknown) => {
      const parsed = getDocumentSchema.parse(args);
      const data = await adapter.getDocument(parsed.documentId);
      return {
        data,
        summary: `Document ${parsed.documentId} returned.`,
      };
    },
    inputSchema: getDocumentSchema,
    name: "get_document",
  },
  {
    description: "Search workspace documents by query and optional metadata filters.",
    execute: async (args: unknown) => {
      const parsed = searchDocumentsSchema.parse(args);
      const data = await adapter.searchDocuments(parsed);
      return {
        data,
        summary: `Document search completed for query "${parsed.query}".`,
      };
    },
    inputSchema: searchDocumentsSchema,
    name: "search_documents",
  },
  {
    description: "Generate a grounded answer from Radioso's existing workspace chat path, including citations when available.",
    execute: async (args: unknown) => {
      const parsed = answerGroundedSchema.parse(args);
      const data = await adapter.answerGrounded(parsed);
      return {
        data,
        summary: `Grounded answer completed for query "${parsed.query}".`,
      };
    },
    inputSchema: answerGroundedSchema,
    name: "answer_grounded",
  },
  {
    description: "Read the current retrieval settings for the configured workspace.",
    execute: async () => ({
      data: await adapter.getRetrievalSettings(),
      summary: "Workspace retrieval settings returned.",
    }),
    inputSchema: emptySchema,
    name: "get_retrieval_settings",
  },
];
