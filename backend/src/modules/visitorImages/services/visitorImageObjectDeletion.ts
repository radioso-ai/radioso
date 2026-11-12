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
import type { VisitorImageObject, VisitorImageObjectStore } from "../domain.js";

/** Objects one job deletes. A conversation holds at most three per message, so most jobs hold a few. */
const OBJECTS_PER_JOB = 100;

/**
 * The only paths a job may delete: one photo's object under its workspace. A payload naming
 * anything else is refused before any delete, so the job can never reach a document or a logo.
 */
const VISITOR_IMAGE_OBJECT_PATH = /^workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/visitor-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Deletes stored photos whose rows a deletion already removed: a conversation's erasure, or the
 * sweep of photos no message carried. The rows and this job commit together in the deletion's
 * transaction, so a photo's bytes never outlive its row unrecorded; the job deletes them after the
 * commit. An object already gone counts as deleted, so a retried run is safe. A failed delete
 * fails the run, which retries over about two hours before the job is dead-lettered and reported.
 */
const VISITOR_IMAGE_OBJECT_DELETION_JOB = defineBackgroundJob({
  kind: "visitor_images.object_deletion",
  payload: z.object({
    objects: z.array(z.object({
      bucket: z.string().min(1).max(255),
      objectPath: z.string().regex(VISITOR_IMAGE_OBJECT_PATH),
      generation: z.string().max(64).nullable(),
    })).min(1).max(OBJECTS_PER_JOB),
  }),
  onDuplicateKey: "ignore",
  maxAttempts: 8,
  timeoutSeconds: 120,
  leaseSeconds: 180,
  retryBaseDelaySeconds: 60,
});

const deletionRequests = (objects: readonly VisitorImageObject[]): BackgroundJobRequest[] => {
  const requests: BackgroundJobRequest[] = [];
  for (let start = 0; start < objects.length; start += OBJECTS_PER_JOB) {
    const batch = objects.slice(start, start + OBJECTS_PER_JOB)
      .map((object) => ({ bucket: object.bucket, objectPath: object.objectPath, generation: object.generation }));
    requests.push(backgroundJobRequest(VISITOR_IMAGE_OBJECT_DELETION_JOB, { objects: batch }));
  }
  return requests;
};

/** Writes the deletion of `objects` inside the caller's transaction, so it commits with the rows it follows. */
export const handOffVisitorImageObjects = async (
  jobs: Pick<BackgroundJobWriter, "insert">,
  transaction: Db,
  objects: readonly VisitorImageObject[],
): Promise<void> => {
  for (const request of deletionRequests(objects)) {
    await jobs.insert(request, transaction);
  }
};

export const visitorImageObjectDeletionHandler = (deps: {
  objects: Pick<VisitorImageObjectStore, "remove">;
  logger: { warn(fields: Record<string, unknown>, message: string): void };
}): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(VISITOR_IMAGE_OBJECT_DELETION_JOB, async ({ objects }, { jobId }) => {
    for (const object of objects) {
      try {
        await deps.objects.remove(object);
      } catch (error) {
        deps.logger.warn({ jobId, errorClass: errorClassOf(error) }, "visitor_image_object_delete_failed");
        throw error;
      }
    }
  });
