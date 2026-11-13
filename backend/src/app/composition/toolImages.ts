import type { Kysely } from "kysely";

import { BackgroundJobRepository } from "../../db/repositories/backgroundJobRepository.js";
import {
  DOCUMENT_IMAGE_RENDITION_WIDTHS,
  type DocumentImageObjectLookup,
} from "../../modules/documents/contracts/index.js";
import type { DocumentStorageLocator, DocumentStoragePort } from "../../modules/documents/contracts/storage.js";
import {
  PostgresToolImageStore,
  StoredToolImageIntake,
  ToolImageCapture,
  ToolImageLookup,
  toolImageCaptureHandler,
  toolImageObjectDeletionHandler,
} from "../../modules/toolImages/composition.js";
import type {
  ToolImageIntake,
  ToolImageObjectStore,
  ToolImagePreviewRecorder,
  ToolImageRowWriter,
} from "../../modules/toolImages/public.js";
import type { BackgroundJobHandlerRegistration, BackgroundJobQueue } from "../../shared/background-jobs/index.js";
import { errorClassOf } from "../../shared/observability/errorClass.js";
import { fetchPublicBytes } from "../../shared/infra/http/publicBytesFetch.js";
import type { DB } from "../../shared/infra/kysely/types.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";

/**
 * Document storage, narrowed to a tool image's objects under the workspace's `tool-images` folder:
 * `<imageId>-source` for bytes a skill returned, `<imageId>-w<width>` for each WebP copy. Each path
 * is written once, so its row names it with no generation.
 */
const toolImageObjectStore = (storage: DocumentStoragePort & DocumentStorageLocator): ToolImageObjectStore => {
  const documentId = (imageId: string, suffix: string) => `${imageId}-${suffix}`;
  return {
    locate: ({ workspaceId, imageId, suffix }) => {
      const located = storage.locate({ workspaceId, documentId: documentId(imageId, suffix), folder: "tool-images" });
      return { bucket: located.bucket, objectPath: located.objectPath, generation: null };
    },
    put: async ({ workspaceId, imageId, suffix, bytes, mimeType }) => {
      const stored = await storage.upload({
        workspaceId,
        documentId: documentId(imageId, suffix),
        folder: "tool-images",
        filename: suffix === "source" ? "source" : "image.webp",
        mimeType,
        buffer: bytes,
      });
      return { sizeBytes: stored.sizeBytes };
    },
    get: (object) => storage.read(object),
    remove: (object) => storage.delete(object),
  };
};

/** Finds a reply image among the documents' images first, then among the tool images. */
export const composeReplyImageLookup = (
  documents: DocumentImageObjectLookup,
  tools: DocumentImageObjectLookup,
): DocumentImageObjectLookup => ({
  findServable: async (input) => (await documents.findServable(input)) ?? tools.findServable(input),
});

/**
 * Tool images: the pictures a reply's cards show from a skill's result, copied per conversation.
 * The rows a reply's transaction writes, the intake that keeps bytes an MCP tool returned, the
 * image route's on-demand lookup, and the jobs that copy and delete. The erasure and the sweep are
 * bound in `conversationErasure.ts` and `conversationRetention.ts`.
 */
export const wireToolImages = (deps: {
  database: { kysely: Kysely<DB> };
  storage: DocumentStoragePort & DocumentStorageLocator;
  jobs: Pick<BackgroundJobQueue, "enqueueInTransaction" | "wake">;
  metrics?: MetricsRegistry | null;
  logger: AppLogger;
}): {
  rows: ToolImageRowWriter;
  previews: ToolImagePreviewRecorder;
  intake: ToolImageIntake;
  lookup: DocumentImageObjectLookup;
  jobHandlers: BackgroundJobHandlerRegistration[];
} => {
  const objects = toolImageObjectStore(deps.storage);
  const store = new PostgresToolImageStore(deps.database.kysely, (trx) => new BackgroundJobRepository(trx));
  const capture = new ToolImageCapture({
    store,
    objects,
    fetchBytes: (url, limits) => fetchPublicBytes(url, limits),
    renditionWidths: DOCUMENT_IMAGE_RENDITION_WIDTHS,
    metrics: deps.metrics,
    logger: deps.logger,
  });
  // A failed write costs the preview its pictures, never the turn its reply.
  const previews: ToolImagePreviewRecorder = {
    recordPreview: async (input) => {
      try {
        await deps.database.kysely.transaction().execute(async (trx) => {
          for (const job of await store.recordPreview(trx, input)) await deps.jobs.enqueueInTransaction(trx, job);
        });
        await deps.jobs.wake();
      } catch (error) {
        deps.logger.warn({ workspaceId: input.workspaceId, errorClass: errorClassOf(error) }, "tool_image_preview_record_failed");
      }
    },
  };
  return {
    rows: store,
    previews,
    intake: new StoredToolImageIntake({ objects, rows: store, logger: deps.logger }),
    lookup: new ToolImageLookup({ store, capture }),
    jobHandlers: [
      toolImageCaptureHandler({ capture, store }),
      toolImageObjectDeletionHandler({ objects, logger: deps.logger }),
    ],
  };
};
