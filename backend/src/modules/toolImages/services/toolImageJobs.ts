import { z } from "zod";

import {
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobRequest,
  type BackgroundJobWriter,
} from "../../../shared/background-jobs/index.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import {
  TOOL_IMAGE_LIMITS,
  TRANSIENT_CAPTURE_OUTCOMES,
  type ToolImageCaptureOutcome,
  type ToolImageObject,
  type ToolImageObjectStore,
  type ToolImageStore,
} from "../domain.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The only paths a deletion may name: one tool image's object under its workspace. A payload
 * naming anything else is refused before any delete, so the job can never reach a document, a
 * visitor's photo or a logo.
 */
const TOOL_IMAGE_OBJECT_PATH = new RegExp(`^workspaces/${UUID}/tool-images/${UUID}-(?:source|w\\d{2,4})$`);

/** Objects one deletion job carries. A picture has at most three. */
const OBJECTS_PER_JOB = 100;

/**
 * Copies a reply's tool images: written in the reply's transaction and run a few seconds after it
 * commits, so a browser asking for a picture first captures it on demand and the job is the
 * backstop. A transient failure (the network, a busy decoder, a server error) is retried over
 * about fifteen minutes, because signed links expire; past that, the pictures still waiting fail.
 */
const TOOL_IMAGE_CAPTURE_JOB = defineBackgroundJob({
  kind: "tool_images.capture",
  payload: z.object({ imageIds: z.array(z.string().uuid()).min(1).max(TOOL_IMAGE_LIMITS.imagesPerJob) }),
  onDuplicateKey: "ignore",
  maxAttempts: 4,
  retryDelaysSeconds: [30, 120, 600],
  timeoutSeconds: 120,
  leaseSeconds: 180,
});

/** How long after the reply commits the job first runs, leaving the first view to capture on demand. */
const CAPTURE_DELAY_MS = 5_000;

/**
 * Deletes the stored objects of tool images whose rows a deletion already removed or retired: a
 * conversation's erasure, the sweep of pictures no message carried, or a picture's own source once
 * it is copied. The rows and this job commit together, so an object never outlives its row
 * unrecorded. An object already gone counts as deleted, so a retried run is safe.
 */
const TOOL_IMAGE_OBJECT_DELETION_JOB = defineBackgroundJob({
  kind: "tool_images.object_deletion",
  payload: z.object({
    objects: z.array(z.object({
      bucket: z.string().min(1).max(255),
      objectPath: z.string().regex(TOOL_IMAGE_OBJECT_PATH),
      generation: z.string().max(64).nullable(),
    })).min(1).max(OBJECTS_PER_JOB),
  }),
  onDuplicateKey: "ignore",
  maxAttempts: 8,
  timeoutSeconds: 120,
  leaseSeconds: 180,
  retryBaseDelaySeconds: 60,
});

const chunks = <T>(values: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    batches.push(values.slice(start, start + size));
  }
  return batches;
};

/** The capture jobs for a reply's pictures, to be written in the reply's transaction. */
export const toolImageCaptureRequests = (imageIds: readonly string[], now: Date = new Date()): BackgroundJobRequest[] =>
  chunks(imageIds, TOOL_IMAGE_LIMITS.imagesPerJob).map((batch) =>
    backgroundJobRequest(TOOL_IMAGE_CAPTURE_JOB, { imageIds: batch }, { runAfter: new Date(now.getTime() + CAPTURE_DELAY_MS) }));

/** Writes the deletion of `objects` inside the caller's transaction, so it commits with the rows it follows. */
export const handOffToolImageObjects = async (
  jobs: Pick<BackgroundJobWriter, "insert">,
  transaction: Db,
  objects: readonly ToolImageObject[],
): Promise<void> => {
  for (const batch of chunks(objects, OBJECTS_PER_JOB)) {
    const payload = { objects: batch.map(({ bucket, objectPath, generation }) => ({ bucket, objectPath, generation })) };
    await jobs.insert(backgroundJobRequest(TOOL_IMAGE_OBJECT_DELETION_JOB, payload), transaction);
  }
};

/** Thrown so the runtime retries a job whose pictures failed for a reason a later attempt may get past. */
class ToolImageCaptureRetryError extends Error {
  constructor(readonly pending: number) {
    super("tool_image_capture_retry");
    this.name = "ToolImageCaptureRetryError";
  }
}

export const toolImageCaptureHandler = (deps: {
  capture: { capture(imageId: string, trigger: "job"): Promise<ToolImageCaptureOutcome | "held"> };
  store: Pick<ToolImageStore, "failPending">;
}): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(
    TOOL_IMAGE_CAPTURE_JOB,
    async ({ imageIds }) => {
      let pending = 0;
      for (const imageId of imageIds) {
        const outcome = await deps.capture.capture(imageId, "job");
        if (outcome === "held" || TRANSIENT_CAPTURE_OUTCOMES.has(outcome)) pending += 1;
      }
      if (pending > 0) throw new ToolImageCaptureRetryError(pending);
    },
    {
      onDeadLetter: async (payload) => {
        if (payload) await deps.store.failPending({ imageIds: payload.imageIds, reason: "retries_exhausted" });
      },
    },
  );

export const toolImageObjectDeletionHandler = (deps: {
  objects: Pick<ToolImageObjectStore, "remove">;
  logger: { warn(fields: Record<string, unknown>, message: string): void };
}): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(TOOL_IMAGE_OBJECT_DELETION_JOB, async ({ objects }, { jobId }) => {
    for (const object of objects) {
      try {
        await deps.objects.remove(object);
      } catch (error) {
        deps.logger.warn({ jobId, errorClass: errorClassOf(error) }, "tool_image_object_delete_failed");
        throw error;
      }
    }
  });
