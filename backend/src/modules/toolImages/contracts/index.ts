import type { BackgroundJobRequest } from "../../../shared/background-jobs/index.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * A picture a reply's card shows from a skill's result. `url` is an address the record named, to
 * be fetched and copied; `inline` is a picture the skill returned as bytes, already kept while it
 * ran. Either way the card stores only `imageId`, never the address.
 */
export type ToolImageSource =
  | { readonly kind: "url"; readonly imageId: string; readonly url: string }
  | { readonly kind: "inline"; readonly imageId: string };

/**
 * Records a reply's tool images in the reply's own transaction: the rows of addresses to copy, and
 * the binding of pictures already kept to the message. Returns the capture jobs to write in the
 * same transaction, so a picture is never copied for a reply that did not commit.
 */
export interface ToolImageRowWriter {
  record(
    transaction: Db,
    input: {
      workspaceId: string;
      conversationId: string;
      messageId: string;
      sources: readonly ToolImageSource[];
    },
  ): Promise<BackgroundJobRequest[]>;
}

/** Why a picture a skill returned as bytes was not kept. Bounded: each is a metric label. */
export type ToolImageIntakeDropReason = "unsupported_type" | "too_large" | "over_limit" | "no_conversation" | "store_failed";

/**
 * Keeps a picture a skill returned as bytes while the skill runs, untouched, for the conversation
 * that called it. A later job re-encodes it; nothing could fetch it again.
 */
export interface ToolImageIntake {
  accept(input: {
    workspaceId: string;
    conversationId: string;
    bytes: Buffer;
  }): Promise<{ kept: true; imageId: string } | { kept: false; reason: ToolImageIntakeDropReason }>;
}
