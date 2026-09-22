import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

/**
 * What a calling agent reads when it comes back to a conversation after a handoff.
 * Registered so the MCP package and the SDK consume the same shape.
 */
export const registerConverseMessagesSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const ConverseMessageSchema = registry.register(
    "ConverseMessage",
    z.object({
      id: z.string(),
      author: z.enum(["agent", "human"]),
      createdAt: z.string().datetime(),
      text: z.string(),
    }).openapi({
      description: "One message in the conversation. `author` is provenance, not role: an operator's reply is stored as an assistant message, so `human` is the only thing that tells a person's turn from the agent's.",
    }),
  );

  const ConverseOwnershipStateSchema = registry.register(
    "ConverseOwnershipState",
    z.object({
      state: z.enum(["ai_owned", "human_owned"]),
    }).openapi({
      description: "Who owns the conversation right now. `human_owned` means a person has taken it over and the agent is not answering, so keep reading rather than asking again.",
    }),
  );

  const ConverseMessagesResponseSchema = registry.register(
    "ConverseMessagesResponse",
    z.object({
      messages: z.array(ConverseMessageSchema),
      cursor: z.string().nullable(),
      ownership: ConverseOwnershipStateSchema,
    }).openapi({
      description: "Messages after the request's cursor, the cursor to resume from, and who owns the conversation now. `cursor` is null only while the conversation holds no messages.",
    }),
  );

  Object.assign(schemas, {
    ConverseMessageSchema,
    ConverseOwnershipStateSchema,
    ConverseMessagesResponseSchema,
  });
};
