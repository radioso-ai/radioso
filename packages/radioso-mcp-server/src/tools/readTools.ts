import { z } from "zod";

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

export const createReadToolDefinitions = (): GenericToolDefinition[] => [
  {
    accessMode: "read",
    description: "Describe the read and write tools available from this Radioso MCP server.",
    execute: async (_args, context) => {
      const grantedTools = context.authInfo?.grantedTools;
      const data = grantedTools
        ? {
            approvalRequiredTools: context.authInfo?.approvalRequiredTools ?? [],
            readTools: capabilityNames.readTools.filter((tool) => grantedTools.includes(tool)),
            upstream: {
              apiVersion: context.authInfo?.upstreamApiVersion,
              mcpContextVersion: context.authInfo?.upstreamMcpContextVersion,
              supportedTools: context.authInfo?.upstreamSupportedTools ?? [],
            },
            workspace: {
              id: context.authInfo?.workspaceId,
              hint: context.authInfo?.workspaceHint,
              name: context.authInfo?.workspaceName,
            },
            writeTools: capabilityNames.writeTools.filter((tool) => grantedTools.includes(tool)),
          }
        : capabilityNames;

      return {
        data,
        summary:
          context.authInfo === null
            ? "Available Radioso MCP capabilities returned."
            : "Session-scoped available Radioso MCP capabilities returned.",
      };
    },
    inputSchema: emptySchema,
    name: "describe_capabilities",
  },
  {
    accessMode: "read",
    description: "List workspace documents visible to the configured Radioso API token.",
    execute: async (args: unknown, context) => {
      const parsed = listDocumentsSchema.parse(args);
      const data = await context.adapter.listDocuments(parsed);
      return {
        data,
        summary: "Workspace documents returned.",
      };
    },
    inputSchema: listDocumentsSchema,
    name: "list_documents",
  },
  {
    accessMode: "read",
    description: "Fetch one workspace document by ID.",
    execute: async (args: unknown, context) => {
      const parsed = getDocumentSchema.parse(args);
      const data = await context.adapter.getDocument(parsed.documentId);
      return {
        data,
        summary: `Document ${parsed.documentId} returned.`,
      };
    },
    inputSchema: getDocumentSchema,
    name: "get_document",
  },
  {
    accessMode: "read",
    description: "Search workspace documents by query and optional metadata filters.",
    execute: async (args: unknown, context) => {
      const parsed = searchDocumentsSchema.parse(args);
      const data = await context.adapter.searchDocuments(parsed);
      return {
        data,
        summary: `Document search completed for query "${parsed.query}".`,
      };
    },
    inputSchema: searchDocumentsSchema,
    name: "search_documents",
  },
  {
    accessMode: "read",
    description: "Generate a grounded answer from Radioso's existing workspace chat path, including citations when available.",
    execute: async (args: unknown, context) => {
      const parsed = answerGroundedSchema.parse(args);
      const data = await context.adapter.answerGrounded(parsed);
      return {
        data,
        summary: `Grounded answer completed for query "${parsed.query}".`,
      };
    },
    inputSchema: answerGroundedSchema,
    name: "answer_grounded",
  },
  {
    accessMode: "read",
    description: "Read the current retrieval settings for the configured workspace.",
    execute: async (_args, context) => ({
      data: await context.adapter.getRetrievalSettings(),
      summary: "Workspace retrieval settings returned.",
    }),
    inputSchema: emptySchema,
    name: "get_retrieval_settings",
  },
];
