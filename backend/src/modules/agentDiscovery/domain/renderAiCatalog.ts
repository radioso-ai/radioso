import { z } from "zod";

import type { AgentPublicProfile } from "../contracts/agentPublicProfile.js";
import { endpointRelativeServerCardUrl } from "./discoveryDocumentUrls.js";

const catalogToolSchema = z.object({
  name: z.string(),
  description: z.string(),
});

const catalogEntrySchema = z.object({
  publicId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  documentationUrl: z.string().nullable(),
  authentication: z.enum(["none", "bearer"]),
  mcp: z.object({
    url: z.string(),
    transport: z.literal("streamable-http"),
    serverCardUrl: z.string(),
  }),
  tools: z.array(catalogToolSchema),
  publishedAt: z.string(),
});

export const aiCatalogSchema = z.object({
  agents: z.array(catalogEntrySchema),
});

type AiCatalog = z.infer<typeof aiCatalogSchema>;

/**
 * Renders the catalog entry for one agent. The site-level catalog a customer publishes at
 * their own origin is a list; the copy Radioso serves is scoped to one public id, so it is
 * a list of one. Every URL it carries is either injected configuration or derived from the
 * endpoint, so the document never has to know the host that served it.
 */
export const renderAiCatalog = (profile: AgentPublicProfile): AiCatalog => ({
  agents: [{
    publicId: profile.publicId,
    name: profile.name,
    description: profile.description,
    documentationUrl: profile.documentationUrl,
    authentication: profile.walkInEnabled ? "none" : "bearer",
    mcp: {
      url: profile.mcpEndpointUrl,
      transport: "streamable-http",
      serverCardUrl: endpointRelativeServerCardUrl(profile.mcpEndpointUrl),
    },
    tools: profile.tools.map((tool) => ({ name: tool.toolName, description: tool.description })),
    publishedAt: profile.revisionPublishedAt,
  }],
});
