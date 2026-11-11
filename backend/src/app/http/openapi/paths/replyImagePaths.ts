import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas } from "../openApiRegistry.js";

const replyImageParamsSchema = z.object({
  imageId: z.string().uuid().openapi({ description: "The image's id, from the `image.src` of a reply block item." }),
  width: z.enum(["320", "640"]).openapi({ description: "The rendition width in pixels." }),
});

export const registerReplyImagePaths = (registry: OpenAPIRegistry, schemas: OpenApiSchemas) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/public/reply-images/{imageId}/{width}",
    tags: ["Assistant"],
    summary: "Read a reply block's image",
    description: "Unauthenticated: the image id is an unguessable capability, so a page embedding the chat loads it cross-origin and a messaging provider can fetch it. Clients take the address from a reply block's `image.src` or `image.srcSet` rather than building it. Responses are WebP, `Cache-Control: private`, and `Cross-Origin-Resource-Policy: cross-origin`. Once the document the image came from is deleted, the image answers 404.",
    operationId: "getPublicReplyImage",
    request: {
      params: replyImageParamsSchema,
    },
    responses: {
      200: {
        description: "The image, re-encoded as WebP at the requested width",
        content: {
          "image/webp": { schema: { type: "string", format: "binary" } },
        },
      },
      404: {
        description: "Unknown image, an image whose document was deleted, or a width other than 320 or 640",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
