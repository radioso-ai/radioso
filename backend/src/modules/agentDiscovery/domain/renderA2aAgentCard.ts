import { z } from "zod";

import type { AgentPublicProfile } from "../contracts/agentPublicProfile.js";

/**
 * The A2A protocol version whose Agent Card shape this renders. Named here rather than
 * inferred, because the card's field names are the contract: a later A2A major renames
 * `url` to an interface list, and that is a deliberate change, not a silent one.
 */
const A2A_PROTOCOL_VERSION = "0.3.0";

/**
 * A2A's transport field is an open string whose core values are the three A2A bindings.
 * Radioso answers MCP at that URL and says so, rather than claiming a binding it does not
 * speak — a client that does not know `MCP` learns the endpoint is not for it.
 */
const A2A_TRANSPORT = "MCP";

const TEXT_MODE = "text/plain";

const a2aSecuritySchemeSchema = z.object({
  type: z.literal("http"),
  scheme: z.string(),
  description: z.string().optional(),
});

const a2aAgentSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  inputModes: z.array(z.string()),
  outputModes: z.array(z.string()),
});

export const a2aAgentCardSchema = z.object({
  protocolVersion: z.string(),
  name: z.string(),
  description: z.string(),
  url: z.string(),
  preferredTransport: z.string(),
  version: z.string(),
  documentationUrl: z.string().optional(),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
    stateTransitionHistory: z.boolean(),
  }),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  securitySchemes: z.record(a2aSecuritySchemeSchema),
  security: z.array(z.record(z.array(z.string()))),
  skills: z.array(a2aAgentSkillSchema),
});

type A2aAgentCard = z.infer<typeof a2aAgentCardSchema>;

/**
 * An empty requirement object is OpenAPI's — and therefore A2A's — way of saying "no
 * credential needed". It is listed first so a caller reading top-down finds the cheapest
 * way in, with `bearer` behind it for the operator-minted grants that always work.
 */
const securityRequirements = (walkInEnabled: boolean): Array<Record<string, string[]>> =>
  walkInEnabled ? [{}, { bearer: [] }] : [{ bearer: [] }];

/**
 * Renders the A2A Agent Card for one agent. Pure, and deliberately total: every agent the
 * profile port hands over gets a card, including one with no tools and no walk-in access,
 * because "this door exists and needs a credential" is itself worth discovering.
 */
export const renderA2aAgentCard = (profile: AgentPublicProfile): A2aAgentCard => ({
  protocolVersion: A2A_PROTOCOL_VERSION,
  name: profile.name,
  description: profile.description ?? "",
  url: profile.mcpEndpointUrl,
  preferredTransport: A2A_TRANSPORT,
  version: profile.revisionVersion,
  ...(profile.documentationUrl ? { documentationUrl: profile.documentationUrl } : {}),
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: [TEXT_MODE],
  defaultOutputModes: [TEXT_MODE],
  securitySchemes: {
    bearer: {
      type: "http",
      scheme: "bearer",
      description: "An access grant token an operator mints for this agent.",
    },
  },
  security: securityRequirements(profile.walkInEnabled),
  skills: profile.tools.map((tool) => ({
    id: tool.toolName,
    // The descriptor carries no display name, and inventing one would mean deriving prose
    // from an identifier in a product that is not English-only. The invocable name is the
    // honest answer to "what is this called".
    name: tool.toolName,
    description: tool.description,
    // Radioso has no tag vocabulary. An empty list satisfies the schema without making one up.
    tags: [],
    inputModes: [TEXT_MODE],
    outputModes: [TEXT_MODE],
  })),
});
