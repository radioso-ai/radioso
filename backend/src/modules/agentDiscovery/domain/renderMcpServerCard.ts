import { z } from "zod";

import type { AgentPublicProfile } from "../contracts/agentPublicProfile.js";

/** The registry server document caps a description at 100 characters. */
const DESCRIPTION_MAX_LENGTH = 100;

/** Reverse-DNS namespace for every Radioso-hosted agent server. */
const SERVER_NAME_NAMESPACE = "ai.radioso";

/** Vendor metadata key; the server document reserves `_meta` for reverse-DNS namespaced facts. */
const RADIOSO_META_KEY = "ai.radioso/agent";

const radiosoServerMetaSchema = z.object({
  title: z.string(),
  publicId: z.string(),
  /** `none` when a caller may walk in; `bearer` when a minted grant is required. */
  authentication: z.enum(["none", "bearer"]),
  tools: z.array(z.string()),
  publishedAt: z.string(),
});

export const mcpServerCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  websiteUrl: z.string().optional(),
  remotes: z.array(z.object({
    type: z.literal("streamable-http"),
    url: z.string(),
  })),
  _meta: z.object({ [RADIOSO_META_KEY]: radiosoServerMetaSchema }),
});

type McpServerCard = z.infer<typeof mcpServerCardSchema>;

const boundedDescription = (profile: AgentPublicProfile): string => {
  const written = profile.description?.trim();
  // The document requires a description of at least one character, so an agent nobody has
  // described falls back to its name rather than publishing an empty string.
  const text = written && written.length > 0 ? written : profile.name;
  return text.length > DESCRIPTION_MAX_LENGTH ? text.slice(0, DESCRIPTION_MAX_LENGTH) : text;
};

/**
 * Renders the MCP server card for one agent, in the shape the published MCP server
 * document uses. `$schema` is deliberately absent: the server-card extension reserves the
 * endpoint-relative path but has not published a schema URL, and a link to a document that
 * does not resolve is worse than no link.
 */
export const renderMcpServerCard = (profile: AgentPublicProfile): McpServerCard => ({
  name: `${SERVER_NAME_NAMESPACE}/${profile.publicId}`,
  description: boundedDescription(profile),
  version: profile.revisionVersion,
  ...(profile.documentationUrl ? { websiteUrl: profile.documentationUrl } : {}),
  remotes: [{ type: "streamable-http", url: profile.mcpEndpointUrl }],
  _meta: {
    [RADIOSO_META_KEY]: {
      title: profile.name,
      publicId: profile.publicId,
      authentication: profile.walkInEnabled ? "none" : "bearer",
      tools: profile.tools.map((tool) => tool.toolName),
      publishedAt: profile.revisionPublishedAt,
    },
  },
});
