import { z } from "zod";

import {
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobQueue,
  type BackgroundJobRequest,
} from "../../../shared/background-jobs/index.js";
import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import {
  VoiceRecordingRequestError,
  type VoiceRecordingErasureBacklog,
  type VoiceRecordingErasureBatch,
  type VoiceRecordingErasureItem,
  type VoiceRecordingLeftReason,
  type VoiceRecordingSource,
  type VoiceVendorCredential,
  type VoiceVendorCredentialSealer,
} from "../domain.js";
import { recordingErrorFields, type VoiceRecordingAudit } from "./voiceRecordingService.js";

/** Recordings one run asks about: four at a time under the adapter's 5 s timeout fit well inside the run's deadline. */
const RECORDINGS_PER_RUN = 50;
/** At most this many vendor deletes run at once, so a large organization does not flood the vendor. */
const DELETE_CONCURRENCY = 4;
/**
 * Asks of the vendor per recording before it is left there for good. A recording the vendor keeps
 * refusing is asked once per run, and a run with such a refusal retries on the job's backoff, so
 * its asks span the same day of retries as the job's own attempts.
 */
const MAX_ASKS_PER_RECORDING = 8;

/**
 * Deletes at the vendor the recordings one deletion handed to the backlog for one workspace and
 * vendor. The payload names the erasure and nothing else: the backlog holds where each recording
 * is and the sealed key. Keyed by the erasure, and level-triggered: a run asks about a bounded
 * number of recordings and asks for one more run while recordings it has not asked about remain;
 * a run that leaves a refused recording behind fails, so the next waits out the retry backoff,
 * about a day in all. Dead-lettered (the job itself kept failing), it leaves every recording still
 * pending as left at the vendor.
 */
const VOICE_RECORDING_ERASURE_JOB = defineBackgroundJob({
  kind: "voice.recording_erasure",
  payload: z.object({ erasureId: z.string().uuid() }),
  onDuplicateKey: "rerun",
  maxAttempts: MAX_ASKS_PER_RECORDING,
  timeoutSeconds: 120,
  leaseSeconds: 180,
  retryDelaysSeconds: [60, 300, 900, 3_600, 10_800, 21_600, 43_200],
});

/** Keyed by the erasure, so the payload is the key's, as a rerun needs. */
export const voiceRecordingErasureRequest = (erasureId: string): BackgroundJobRequest =>
  backgroundJobRequest(VOICE_RECORDING_ERASURE_JOB, { erasureId }, { idempotencyKey: erasureId });

/** Thrown by a run that left a refused recording behind: the job retries on its backoff. */
class VoiceRecordingErasureIncompleteError extends Error {
  constructor() {
    super("Some voice recordings are still at the vendor; the erasure retries");
    this.name = "VoiceRecordingErasureIncompleteError";
  }
}

const LEFT_REASON_OF_REQUEST_FAILURE: Partial<Record<VoiceRecordingRequestError["reason"], VoiceRecordingLeftReason>> = {
  rejected: "vendor_rejected",
  unreachable: "vendor_unreachable",
  timeout: "vendor_timeout",
  malformed_response: "vendor_malformed_response",
  oversized_response: "vendor_malformed_response",
};

const leftReasonOf = (error: unknown): VoiceRecordingLeftReason =>
  (error instanceof VoiceRecordingRequestError ? LEFT_REASON_OF_REQUEST_FAILURE[error.reason] : undefined) ?? "vendor_failed";

/**
 * How `voice_recording_delete_total` counts: each ask's result, and `left_at_vendor` once for a
 * recording given up on. A closed set, beside the vendor.
 */
type VoiceRecordingDeleteOutcome = "deleted" | "already_absent" | "vendor_failed" | "credential_unreadable" | "left_at_vendor";

/** What asking about one recording came to. `final`: no later ask can change it. */
type Ask =
  | { kind: "gone"; outcome: "deleted" | "already_absent" }
  | { kind: "held"; reason: VoiceRecordingLeftReason; final: boolean; fields: Record<string, unknown> }
  | { kind: "abandoned" };

/** The held key, opened for this run, or why none can be used. */
type OpenedCredential = { kind: "open"; credential: VoiceVendorCredential } | { kind: "absent" } | { kind: "unreadable"; errorClass: string };

interface RunTally {
  deleted: number;
  alreadyAbsent: number;
  retrying: number;
  leftAtVendor: number;
  /** Why the first recording still held was held: its code, and the vendor's reason and status only. */
  firstHeld: Record<string, unknown> | null;
}

interface VoiceRecordingErasureDrainDependencies {
  backlog: VoiceRecordingErasureBacklog;
  /** The backlog over a dead letter's transaction, so giving up commits with the park. */
  backlogIn: (db: Db) => Pick<VoiceRecordingErasureBacklog, "failRemaining">;
  sealer: Pick<VoiceVendorCredentialSealer, "open">;
  sources: Readonly<Record<VoiceVendor, Pick<VoiceRecordingSource, "deleteRecording">>>;
  audit: Pick<VoiceRecordingAudit, "deleted" | "left">;
  queue: Pick<BackgroundJobQueue, "enqueue">;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger: Pick<AppLogger, "info" | "warn">;
}

const forEachConcurrently = async <T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  run: (item: T) => Promise<void>,
): Promise<void> => {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const item = queue.shift();
      if (!item) return;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
};

/**
 * One run of an erasure: claims its pending recordings, those asked least first, asks the vendor to
 * delete each with the held key, and settles each. A recording the vendor deleted, or no longer
 * held, leaves the backlog with its `conversation.recording_deleted` record; one it refused is kept
 * for another ask, until its asks run out and it stays as left at the vendor, with its record and
 * a warn log naming where it is. The key is dropped as soon as no pending recording needs it.
 * Logs and records carry ids, counts and closed codes only, never the key or the vendor's answer.
 */
export class VoiceRecordingErasureDrain {
  constructor(private readonly deps: VoiceRecordingErasureDrainDependencies) {}

  async run(erasureId: string, signal: AbortSignal): Promise<void> {
    const batch = await this.deps.backlog.claim(erasureId, RECORDINGS_PER_RUN);
    // Gone: an earlier run drained it, and this one is a duplicate or a stale rerun.
    if (!batch) return;
    const credential = this.openCredential(batch.sealedCredential);
    const tally: RunTally = { deleted: 0, alreadyAbsent: 0, retrying: 0, leftAtVendor: 0, firstHeld: null };
    await forEachConcurrently(batch.items, DELETE_CONCURRENCY, signal, async (item) => {
      await this.settle(batch, item, await this.ask(batch, credential, item, signal), tally);
    });
    // The deadline passed and the runtime has moved on: the retry claims whatever is left.
    if (signal.aborted) return;

    const remaining = await this.deps.backlog.release(erasureId);
    this.logRun(erasureId, batch, tally, remaining.pending);
    if (remaining.pending === 0) return;
    // Recordings never asked about go now; recordings the vendor refused wait out the backoff.
    if (tally.retrying > 0 && remaining.neverAsked === 0) throw new VoiceRecordingErasureIncompleteError();
    await this.deps.queue.enqueue(voiceRecordingErasureRequest(erasureId));
  }

  /** The job itself kept failing: every recording still pending is left at the vendor, with its record. */
  async giveUp(erasureId: string, transaction: Db): Promise<void> {
    const batch = await this.deps.backlogIn(transaction).failRemaining(erasureId);
    if (!batch) return;
    for (const item of batch.items) {
      await this.leftAtVendor(batch, item, item.failureReason ?? "drain_failed", {});
    }
  }

  private openCredential(sealed: string | null): OpenedCredential {
    if (sealed === null) return { kind: "absent" };
    try {
      return { kind: "open", credential: this.deps.sealer.open(sealed) };
    } catch (error) {
      return { kind: "unreadable", errorClass: errorClassOf(error) };
    }
  }

  private async ask(batch: VoiceRecordingErasureBatch, credential: OpenedCredential, item: VoiceRecordingErasureItem, signal: AbortSignal): Promise<Ask> {
    const final = item.attempts >= MAX_ASKS_PER_RECORDING;
    if (credential.kind === "absent") {
      // The deletion found no key to hand over: no ask can be made, now or later.
      return { kind: "held", reason: item.failureReason ?? "credential_missing", final: true, fields: {} };
    }
    if (credential.kind === "unreadable") {
      return { kind: "held", reason: "credential_unreadable", final, fields: { errorClass: credential.errorClass } };
    }
    try {
      const outcome = await this.deps.sources[batch.vendor].deleteRecording({
        vendorConversationId: item.vendorConversationId,
        region: item.region,
        credential: credential.credential,
        signal,
      });
      return { kind: "gone", outcome };
    } catch (error) {
      if (signal.aborted) return { kind: "abandoned" };
      return { kind: "held", reason: leftReasonOf(error), final, fields: recordingErrorFields(error) };
    }
  }

  private async settle(batch: VoiceRecordingErasureBatch, item: VoiceRecordingErasureItem, ask: Ask, tally: RunTally): Promise<void> {
    if (ask.kind === "abandoned") return;
    if (ask.kind === "gone") {
      this.count(batch.vendor, ask.outcome);
      if (ask.outcome === "deleted") tally.deleted += 1;
      else tally.alreadyAbsent += 1;
      await this.recordDeleted(batch, item, ask.outcome);
      await this.deps.backlog.remove(item.id);
      return;
    }
    if (ask.reason !== "credential_missing") this.count(batch.vendor, ask.reason === "credential_unreadable" ? "credential_unreadable" : "vendor_failed");
    tally.firstHeld ??= { outcome: ask.reason, ...ask.fields };
    if (!ask.final) {
      tally.retrying += 1;
      await this.deps.backlog.keep(item.id, ask.reason);
      return;
    }
    tally.leftAtVendor += 1;
    await this.deps.backlog.fail(item.id, ask.reason);
    await this.leftAtVendor(batch, item, ask.reason, ask.fields);
  }

  /** The recording is gone at the vendor, so a failed audit write is logged with its ids rather than asked again. */
  private async recordDeleted(batch: VoiceRecordingErasureBatch, item: VoiceRecordingErasureItem, outcome: "deleted" | "already_absent"): Promise<void> {
    await this.deps.audit
      .deleted({
        account: batch.account,
        workspaceId: batch.workspace.id,
        workspaceDeleted: batch.workspace.deleted,
        conversationId: item.conversationId,
        vendor: batch.vendor,
        outcome,
      })
      .catch((error: unknown) => {
        this.deps.logger.warn(
          { workspaceId: batch.workspace.id, conversationId: item.conversationId, vendor: batch.vendor, errorClass: errorClassOf(error) },
          "Voice recording deletion could not be audited",
        );
      });
  }

  /** A recording given up on: counted, logged with where it is so an operator can delete it there, and recorded for its organization. */
  private async leftAtVendor(
    batch: VoiceRecordingErasureBatch,
    item: VoiceRecordingErasureItem,
    reason: VoiceRecordingLeftReason,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const { vendor } = batch;
    const { conversationId, vendorConversationId } = item;
    const workspaceId = batch.workspace.id;
    this.count(vendor, "left_at_vendor");
    this.deps.logger.warn(
      { workspaceId, conversationId, vendorConversationId, vendor, outcome: reason, attempts: item.attempts, ...fields },
      "Voice recording was left at the vendor",
    );
    await this.deps.audit
      .left({ account: batch.account, workspaceId, workspaceDeleted: batch.workspace.deleted, conversationId, vendor, vendorConversationId, reason })
      .catch((error: unknown) => {
        this.deps.logger.warn({ workspaceId, conversationId, vendor, errorClass: errorClassOf(error) }, "Voice recording left at the vendor could not be audited");
      });
  }

  private logRun(erasureId: string, batch: VoiceRecordingErasureBatch, tally: RunTally, pending: number): void {
    const { firstHeld, ...counts } = tally;
    const fields = { erasureId, workspaceId: batch.workspace.id, vendor: batch.vendor, ...counts, pending, ...(firstHeld ? { firstHeld } : {}) };
    if (tally.retrying > 0 || tally.leftAtVendor > 0) this.deps.logger.warn(fields, "Voice recording erasure left recordings at the vendor");
    else this.deps.logger.info(fields, "Voice recording erasure ran");
  }

  private count(vendor: VoiceVendor, outcome: VoiceRecordingDeleteOutcome): void {
    this.deps.metrics?.incrementCounter("voice_recording_delete_total", {
      help: "Voice recording deletions at the vendor, by vendor and outcome: each ask's result, and left_at_vendor once a recording is given up on",
      labels: { vendor, outcome },
    });
  }
}

/** The erasure job's handler: one run per claim, and giving up, with the park, once the job is dead-lettered. */
export const voiceRecordingErasureJobHandler = (drain: VoiceRecordingErasureDrain): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(VOICE_RECORDING_ERASURE_JOB, ({ erasureId }, { signal }) => drain.run(erasureId, signal), {
    onDeadLetter: async (payload, { idempotencyKey, transaction }) => {
      const erasureId = payload?.erasureId ?? idempotencyKey;
      if (erasureId) await drain.giveUp(erasureId, transaction);
    },
  });
