import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { replyBlockSchema } from "../../../../modules/chat/contracts/index.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

/**
 * The reply block as a client receives it: on a chat response, on the streamed `block` and `done`
 * events, and on assistant messages read back from history.
 */
export const registerReplyBlockSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  const ReplyBlockSchema = registry.register(
    "ReplyBlock",
    replyBlockSchema.openapi({
      description: "A structured part of an assistant reply that a client renders beside its text. `item_list` is a list of items, such as picture cards, laid out as `carousel`, `grid` or `list`; a client renders a layout it does not know as `list`. A server sends only the block kinds a client declared under `clientContextCapabilities[\"reply.blocks\"]`, and only the layouts it declared, sending `list` in place of any other. Each item is built from the content the answer used: its `image.src` and `image.srcSet` are addresses this server serves, and an item's picture stops loading once the document it came from is deleted.",
    }),
  );
  Object.assign(schemas, { ReplyBlockSchema });
};
