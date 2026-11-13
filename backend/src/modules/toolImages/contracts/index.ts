import type { BackgroundJobRequest } from "../../../shared/background-jobs/index.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

/**
 * A picture a reply's card shows from a skill's result: the address a record named, to be fetched
 * and copied under `imageId`. The card stores only the id, never the address.
 */
export interface ToolImageSource {
  readonly imageId: string;
  readonly url: string;
}

/**
 * Records a reply's tool images in the reply's own transaction and returns the capture jobs to
 * write in the same transaction, so a picture is never copied for a reply that did not commit.
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

/**
 * Records the pictures a reply shows in a conversation no row stores, such as a Test Chat turn's:
 * unbound, copied like any other, and swept a day after they were written.
 */
export interface ToolImagePreviewRecorder {
  recordPreview(input: { workspaceId: string; sources: readonly ToolImageSource[] }): Promise<void>;
}
