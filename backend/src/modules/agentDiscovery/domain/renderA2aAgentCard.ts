import { z } from "zod";

import { A2A_CONVERSE_EXTENSION_URI } from "../../../shared/domain/a2aConverseExtension.js";
import type { AgentPublicProfile } from "../contracts/agentPublicProfile.js";
import { endpointRelativeServerCardUrl } from "./discoveryDocumentUrls.js";

/**
 * The A2A version this card is written for, and the one its single interface speaks. Named
 * here rather than inferred, because the card's field names are the contract: a later A2A
 * major reshapes the card, and that is a deliberate change, not a silent one. Field names
 * follow the normative `a2a.proto` in ProtoJSON (camelCase), including its `oneof` wrappers.
 */
const A2A_PROTOCOL_VERSION = "1.0";

/** The one binding Radioso implements. MCP is not an A2A binding: it does not serve every core operation. */
const A2A_PROTOCOL_BINDING = "JSONRPC";

const TEXT_MODE = "text/plain";

/** The always-present skill: a plain message to the agent works whether or not it exposes any routine. */
const ASK_AGENT_SKILL_ID = "ask_agent";

const BEARER_SCHEME_NAME = "bearer";

const a2aInterfaceSchema = z.object({
  url: z.string(),
  protocolBinding: z.string(),
  protocolVersion: z.string(),
});

/** `SecurityScheme` is a protobuf `oneof`, which ProtoJSON writes as one wrapper key naming the member. */
const a2aSecuritySchemeSchema = z.object({
  httpAuthSecurityScheme: z.object({
    scheme: z.string(),
    description: z.string().optional(),
  }),
});

/** `SecurityRequirement.schemes` maps a scheme name to a `StringList`, which ProtoJSON wraps as `{ list }`. */
const a2aSecurityRequirementSchema = z.object({
  schemes: z.record(z.string(), z.object({ list: z.array(z.string()) })),
});

const a2aAgentSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  // v1.0 §5.7: an array the proto marks required must hold at least one element.
  tags: z.array(z.string()).min(1),
  inputModes: z.array(z.string()),
  outputModes: z.array(z.string()),
});

const a2aConverseExtensionParamsSchema = z.object({
  mcp: z.object({
    url: z.string(),
    serverCardUrl: z.string(),
  }),
  // A2A skills carry no input schema, so each exposed tool's descriptor travels here.
  tools: z.array(z.object({
    toolName: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  })),
});

const a2aAgentExtensionSchema = z.object({
  uri: z.string(),
  description: z.string(),
  required: z.boolean(),
  params: a2aConverseExtensionParamsSchema,
});

export const a2aAgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  supportedInterfaces: z.array(a2aInterfaceSchema).min(1),
  version: z.string(),
  documentationUrl: z.string().optional(),
  capabilities: z.object({
    streaming: z.boolean(),
    pushNotifications: z.boolean(),
    extendedAgentCard: z.boolean(),
    extensions: z.array(a2aAgentExtensionSchema),
  }),
  securitySchemes: z.record(z.string(), a2aSecuritySchemeSchema),
  securityRequirements: z.array(a2aSecurityRequirementSchema).optional(),
  defaultInputModes: z.array(z.string()).min(1),
  defaultOutputModes: z.array(z.string()).min(1),
  skills: z.array(a2aAgentSkillSchema).min(1),
});

type A2aAgentCard = z.infer<typeof a2aAgentCardSchema>;
type A2aAgentSkill = z.infer<typeof a2aAgentSkillSchema>;

/**
 * A skill's tags are its id: an identifier, not vocabulary invented for it. Radioso has no
 * tag taxonomy, and v1.0 will not take an empty list, so the id is the one true label.
 */
const skill = (input: Pick<A2aAgentSkill, "id" | "name" | "description">): A2aAgentSkill => ({
  ...input,
  tags: [input.id],
  inputModes: [TEXT_MODE],
  outputModes: [TEXT_MODE],
});

/**
 * Walk-in access is the absence of a requirement. A2A defines no meaning for an empty
 * requirement object, so while walk-in is open the card states none and leaves `bearer`
 * declared for callers that hold a grant. When walk-in is closed the bearer is required.
 */
const securityRequirements = (walkInEnabled: boolean): Pick<A2aAgentCard, "securityRequirements"> =>
  walkInEnabled
    ? {}
    : { securityRequirements: [{ schemes: { [BEARER_SCHEME_NAME]: { list: [] } } }] };

/**
 * Renders the A2A v1.0 Agent Card for one agent. Pure, and deliberately total: every agent
 * the profile port hands over gets a card, including one with no tools and no walk-in
 * access, because "this door exists and needs a credential" is itself worth discovering.
 */
export const renderA2aAgentCard = (profile: AgentPublicProfile): A2aAgentCard => ({
  name: profile.name,
  description: profile.description ?? "",
  supportedInterfaces: [{
    url: profile.a2aEndpointUrl,
    protocolBinding: A2A_PROTOCOL_BINDING,
    protocolVersion: A2A_PROTOCOL_VERSION,
  }],
  version: profile.revisionVersion,
  ...(profile.documentationUrl ? { documentationUrl: profile.documentationUrl } : {}),
  capabilities: {
    streaming: false,
    pushNotifications: false,
    extendedAgentCard: false,
    extensions: [{
      uri: A2A_CONVERSE_EXTENSION_URI,
      description:
        "Radioso conversation extension. params.mcp names this agent's MCP endpoint and server card; "
        + "params.tools lists each exposed routine with the JSON Schema of its input.",
      required: false,
      params: {
        mcp: {
          url: profile.mcpEndpointUrl,
          serverCardUrl: endpointRelativeServerCardUrl(profile.mcpEndpointUrl),
        },
        tools: profile.tools.map((tool) => ({
          toolName: tool.toolName,
          description: tool.description,
          inputSchema: { ...tool.inputSchema },
        })),
      },
    }],
  },
  defaultInputModes: [TEXT_MODE],
  defaultOutputModes: [TEXT_MODE],
  securitySchemes: {
    [BEARER_SCHEME_NAME]: {
      httpAuthSecurityScheme: {
        scheme: "bearer",
        description: "An access grant token an operator mints for this agent.",
      },
    },
  },
  ...securityRequirements(profile.walkInEnabled),
  skills: [
    skill({ id: ASK_AGENT_SKILL_ID, name: profile.name, description: profile.description ?? "" }),
    // The descriptor carries no display name, and inventing one would mean deriving prose
    // from an identifier in a product that is not English-only. The invocable name is the
    // honest answer to "what is this called".
    ...profile.tools.map((tool) => skill({ id: tool.toolName, name: tool.toolName, description: tool.description })),
  ],
});
