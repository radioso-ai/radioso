import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas } from "../openApiRegistry.js";
import { REPLY_IMAGE_OPENAPI_PATH, REPLY_IMAGE_WIDTHS } from "../../routes/replyImageAddress.js";

const servedWidths = REPLY_IMAGE_WIDTHS.join(" or ");

const replyImageParamsSchema = z.object({
  imageId: z.string().uuid().openapi({ description: "The image's id, from the `image.src` of a reply block item." }),
  width: z.enum(REPLY_IMAGE_WIDTHS).openapi({ description: `The rendition width in pixels, spelled exactly: ${servedWidths}.` }),
});

export const registerReplyImagePaths = (registry: OpenAPIRegistry, schemas: OpenApiSchemas) => {
  registry.registerPath({
    method: "get",
    path: REPLY_IMAGE_OPENAPI_PATH,
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
        description: `Unknown image, an image whose document was deleted, or a width other than ${servedWidths}`,
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
      429: {
        description: "The calling source has used its budget of public reads for the window",
        content: {
          "application/json": {
            schema: schemas.ErrorResponseSchema,
          },
        },
      },
    },
  });
};
