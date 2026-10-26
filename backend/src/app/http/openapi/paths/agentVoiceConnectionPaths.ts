import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { agentVoiceSettingsSchema } from "../../../../modules/agents/public.js";
import { VOICE_RUNTIME_CONNECTION_STATES } from "../../../../modules/voiceChannel/public.js";
import { VOICE_VENDOR_REGIONS, VOICE_VENDORS } from "../../../../shared/domain/voiceVendor.js";
import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

/**
 * The vendor agent Radioso creates and maintains for an agent's voice channel: the Voice card's
 * Connect and Disconnect, and where the runtime stands.
 */
export const registerAgentVoiceConnectionPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const ConnectionSchema = registry.register("AgentVoiceConnection", z.object({
    vendor: z.enum(VOICE_VENDORS).openapi({ description: "The voice vendor the agent's runtime is on: the bound runtime's, else the one Connect sets up." }),
    state: z.enum(VOICE_RUNTIME_CONNECTION_STATES).openapi({
      description: "`not_connected`: no runtime is bound. `connected`: the runtime is a vendor agent Radioso created and maintains. "
        + "`connected_externally`: the runtime names a vendor agent set up outside Radioso.",
    }),
    region: z.enum(VOICE_VENDOR_REGIONS).nullable().openapi({
      description: "The data residency region of the bound vendor account, where the vendor keeps the call's recording; null when no runtime is bound.",
    }),
    vendorKey: z.enum(["stored", "missing", "unreadable"]).openapi({
      description: "Whether the workspace stores the vendor's API key under Settings → Providers: `unreadable` is a key the backend cannot decrypt with its master key.",
    }),
    connectAvailable: z.boolean().openapi({
      description: "False when this deployment has no `PUBLIC_API_BASE_URL`, the public address a vendor agent posts each turn to; Connect then answers `503`.",
    }),
    runtime: agentVoiceSettingsSchema.shape.runtime.openapi({
      description: "The agent's `voice.runtime` as stored after the request. A client that saves the whole `voice` block sends this value, or the save unbinds the agent.",
    }),
  }).openapi({ description: "Where the agent's voice runtime stands." }));
  const DisconnectionSchema = registry.register("AgentVoiceDisconnection", ConnectionSchema.extend({
    vendorAgentLeft: z.boolean().openapi({
      description: "True when the vendor agent Radioso created may still be in the vendor account: the vendor did not delete it, or no readable key was stored. Its credential is revoked either way.",
    }),
  }).openapi({ description: "Where the agent's voice runtime stands after Disconnect." }));

  const params = schemas.AgentParamsSchema;
  const csrfHeaders = z.object({
    "x-radioso-csrf": z.literal("1").openapi({ description: "Required on writes from the dashboard session." }),
  });
  const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: schemas.ErrorResponseSchema } } });
  const common = {
    401: errorResponse("Authentication required; API tokens are refused, this is for dashboard sessions"),
    403: errorResponse("Agent manage permission required, or the CSRF header is missing"),
    404: errorResponse("Agent not found"),
  };

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/voice/connection",
    tags: ["Agents"],
    summary: "Read where the agent's voice runtime stands",
    description: "Whether the agent's voice runtime is a vendor agent Radioso maintains, one set up outside Radioso, or none, with the bound account's region and whether the workspace's vendor key is stored. Dashboard session only.",
    operationId: "getAgentVoiceConnection",
    security: security.workspaceAdminSecurity,
    request: { params },
    responses: {
      200: { description: "The voice runtime's state", content: { "application/json": { schema: ConnectionSchema } } },
      ...common,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/voice/connection",
    tags: ["Agents"],
    summary: "Connect the agent's voice channel to a vendor agent Radioso maintains",
    description: [
      "Creates an ElevenLabs agent on the workspace's own ElevenLabs account, with the key stored under Settings → Providers, and binds the agent's `voice.runtime` to it.",
      "The account's data residency region is found from the key. The ElevenLabs agent posts each turn to `{PUBLIC_API_BASE_URL}/api/v1/agents/{agentId}/voice/elevenlabs/v1` with a REST credential Radioso issues for it (labelled `Voice calls`, no expiry), starts calls in the agent's default language, and can switch to any language ElevenLabs Agents speaks.",
      "Calling it again repairs the connection: the ElevenLabs agent's settings, a binding a save cleared, a credential that was revoked (a new one replaces it). A runtime bound by hand is replaced by one Radioso maintains; the hand-made ElevenLabs agent is left alone.",
      "Records an `agent.voice_runtime.connected` audit event. Dashboard session only.",
    ].join(" "),
    operationId: "connectAgentVoice",
    security: security.workspaceAdminSecurity,
    request: { params, headers: csrfHeaders },
    responses: {
      200: { description: "Connected", content: { "application/json": { schema: ConnectionSchema } } },
      ...common,
      409: errorResponse("`voice_vendor_key_missing`: no vendor key is stored; `voice_vendor_key_unreadable`: the stored key cannot be decrypted"),
      422: errorResponse("`voice_vendor_key_rejected`: the vendor does not accept the key; `voice_vendor_key_lacks_agents_permission`: the key may not read and write the vendor's agents"),
      502: errorResponse("`voice_vendor_failed`: the vendor refused to set up the agent"),
      503: errorResponse("`voice_vendor_unreachable`: the vendor did not answer; `voice_connection_unavailable`: the deployment has no `PUBLIC_API_BASE_URL`"),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/v1/agents/{agentId}/voice/connection",
    tags: ["Agents"],
    summary: "Disconnect the agent's voice runtime",
    description: [
      "Unbinds the agent's `voice.runtime`. A vendor agent Radioso created is deleted from the vendor account with its stored credential, and the credential is revoked;",
      "a runtime bound by hand is only unbound, and its vendor agent left alone. Unbinding never waits on the vendor: `vendorAgentLeft` says when the vendor agent may still be there.",
      "Records an `agent.voice_runtime.disconnected` audit event when there was something to disconnect. Dashboard session only.",
    ].join(" "),
    operationId: "disconnectAgentVoice",
    security: security.workspaceAdminSecurity,
    request: { params, headers: csrfHeaders },
    responses: {
      200: { description: "Disconnected", content: { "application/json": { schema: DisconnectionSchema } } },
      ...common,
    },
  });
};
