import { z } from "zod";

export const mcpConverseClientSchema = z.object({
  name: z.string().trim().min(1).optional(),
  version: z.string().trim().min(1).optional(),
}).optional();

export const mcpConverseSessionRequestSchema = z.object({
  launchToken: z.string().min(1),
  client: mcpConverseClientSchema,
});

export const mcpConverseSessionValidateRequestSchema = z.object({
  sessionToken: z.string().min(1),
});

export const mcpConverseAskRequestSchema = z.object({
  message: z.string().trim().min(1),
  stream: z.literal(false).optional(),
});

export const mcpConverseGroundedAnswerRequestSchema = z.object({
  query: z.string().trim().min(1),
  maxResults: z.number().int().min(1).max(20).optional(),
});

export const mcpConverseResourceParamsSchema = z.object({
  resourceId: z.string().trim().min(1),
});

export const mcpConverseSessionResponseSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.string().datetime(),
  resumeToken: z.string().optional(),
  agent: z.object({
    id: z.string().uuid(),
    name: z.string(),
  }),
  conversationId: z.string().uuid(),
});

export const mcpConverseSessionValidateResponseSchema = z.object({
  valid: z.literal(true),
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  conversationId: z.string().uuid(),
  permissions: z.array(z.string()),
});

export const mcpConverseAskResponseSchema = z.object({
  conversationId: z.string().uuid(),
  answer: z.object({
    text: z.string(),
    citations: z.array(z.unknown()),
  }),
  traceId: z.string().optional(),
});

const mcpConverseCitationSchema = z.object({
  documentId: z.literal(""),
  chunkId: z.literal(""),
  title: z.string(),
  sourceUrl: z.string().url().optional(),
});

export const mcpConverseGroundedAnswerResponseSchema = z.object({
  answer: z.string(),
  citations: z.array(mcpConverseCitationSchema),
  retrieval: z.object({
    agentScoped: z.literal(true),
  }),
});

export const mcpConverseResourceSummarySchema = z.object({
  uri: z.string(),
  name: z.string(),
  mimeType: z.string(),
});

export const mcpConverseResourceListResponseSchema = z.object({
  resources: z.array(mcpConverseResourceSummarySchema),
});

export const mcpConverseResourceResponseSchema = mcpConverseResourceSummarySchema.extend({
  text: z.string(),
});
