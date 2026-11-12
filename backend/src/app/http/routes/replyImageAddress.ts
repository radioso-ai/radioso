import { z } from "zod";

import type { ReplyImageUrls } from "../../../modules/chat/contracts/index.js";

/**
 * The one owner of a reply image's address: where the route is mounted, the widths it serves, and
 * the `src` and `srcSet` a presented block carries. A stored block keeps only the image id, so the
 * address can change without breaking a card already sent.
 */

/** Where the image route is mounted; an image is served at `/{imageId}/{width}` below it. */
export const REPLY_IMAGE_ROUTE_PATH = "/api/v1/public/reply-images";

/** The route's address in OpenAPI form. */
export const REPLY_IMAGE_OPENAPI_PATH = `${REPLY_IMAGE_ROUTE_PATH}/{imageId}/{width}`;

/**
 * The widths the route serves, spelled exactly as the address spells them, smallest first. Any
 * other spelling of the same number (`0640`, `6.4e2`) is a different address and is not served.
 */
export const REPLY_IMAGE_WIDTHS = ["320", "640"] as const;

/** The route's path parameters. */
export const replyImageParamsSchema = z.object({
  imageId: z.string().uuid(),
  width: z.enum(REPLY_IMAGE_WIDTHS),
});

const LARGEST_WIDTH = REPLY_IMAGE_WIDTHS[REPLY_IMAGE_WIDTHS.length - 1];

/**
 * The served addresses of a reply block's image under `publicBaseUrl`, the backend address a
 * browser loads cross-origin and a messaging provider fetches: `src` at the largest width, and
 * `srcSet` at every width.
 */
export const createReplyImageUrls = (publicBaseUrl: string): ReplyImageUrls => {
  const at = (imageId: string, width: string) =>
    `${publicBaseUrl}${REPLY_IMAGE_ROUTE_PATH}/${encodeURIComponent(imageId)}/${width}`;
  return {
    forImage: (imageId) => ({
      src: at(imageId, LARGEST_WIDTH),
      srcSet: REPLY_IMAGE_WIDTHS.map((width) => `${at(imageId, width)} ${width}w`).join(", "),
    }),
  };
};

/** The stored object a reply image's rendition is read from. */
export interface ReplyImageObject {
  bucket: string;
  objectPath: string;
  generation?: string | null;
}

/**
 * Finds the stored object behind a reply image's address. The route serves by this port alone, so
 * it never learns whether an image came from a document or from anywhere else.
 */
export interface ReplyImageObjectLookup {
  /** The rendition of `imageId` at `width` pixels, or null when there is none to serve. */
  findServable(input: { imageId: string; width: number }): Promise<ReplyImageObject | null>;
}
