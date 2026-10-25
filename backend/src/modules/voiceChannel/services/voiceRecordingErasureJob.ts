import { z } from "zod";

import {
  backgroundJobHandler,
  backgroundJobRequest,
  defineBackgroundJob,
  type BackgroundJobHandlerRegistration,
  type BackgroundJobQueue,
  type BackgroundJobRequest,
} from "../../../shared/background-jobs/index.js";
import type { ErrorReporter } from "../../../shared/errors/errorReporter.js";
import { isVoiceVendor, type VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import type { Db } from "../../../shared/infra/kysely/types.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import {
  VoiceRecordingRequestError,
  type VoiceRecordingErasureBacklog,
  type VoiceRecordingErasureEntry,
  type VoiceRecordingErasureItem,
  type VoiceRecordingErasureSubject,
  type VoiceRecordingGivenUp,
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
/** Asks of the vendor per recording before it is left there for good. */
const MAX_ASKS_PER_RECORDING = 8;
/**
 * The wait before a refused recording's next ask, by the asks it has had: a minute, five, fifteen,
 * an hour, three, six, then twelve. Its eight asks span about a day.
 */
const ASK_DELAYS_SECONDS = [60, 300, 900, 3_600, 10_800, 21_600, 43_200] as const;
/** The longest a vendor's `Retry-After` on a refusal is honoured for: the last step of the schedule. */
const MAX_RETRY_AFTER_SECONDS = 43_200;
/** How long a run that met a 429 waits when the vendor names no `Retry-After`, and the most it waits when it does. */
const RATE_LIMIT_PAUSE_SECONDS = { default: 60, max: 3_600 } as const;
/** A recording still pending this long after its deletion is left at the vendor, whatever its asks. */
const EXPIRE_AFTER_SECONDS = 7 * 24 * 60 * 60;
/**
 * How long a claim holds the recordings it took: longer than a run's deadline, so a run that takes
 * over a lost one finds them not yet due rather than asking the vendor about them a second time.
 */
const CLAIM_LEASE_SECONDS = 300;
/** The vendor's answer for too many requests: the run stops asking until it says to come back. Protocol syntax only. */
const RATE_LIMITED_STATUS = 429;

/**
 * Deletes at the vendor the recordings one deletion handed to the backlog for one workspace and
 * vendor. The payload names the erasure and nothing else: the backlog holds where each recording
 * is, when it is next due, and the sealed key. Each run asks about the recordings that are due and
 * queues the next run for when the next one is: at once while more are due, otherwise at that
 * time. A run fails only when it could not do its work at all; the job's own attempts guard against
 * a run that keeps crashing, and once they are spent every recording still pending is left at the
 * vendor.
 */
const VOICE_RECORDING_ERASURE_JOB = defineBackgroundJob({
  kind: "voice.recording_erasure",
  payload: z.object({ erasureId: z.string().uuid() }),
  onDuplicateKey: "rerun",
  maxAttempts: 5,
  timeoutSeconds: 120,
  leaseSeconds: 180,
  retryBaseDelaySeconds: 60,
});

/**
 * A run of one erasure: due now, keyed by the erasure, so a request that arrives while one runs
 * asks for one more run; or due at `runAfter` (rounded up to the minute), keyed by the erasure and
 * that minute, so it waits as its own job while the current one finishes. Either way the payload
 * is the key's.
 */
export const voiceRecordingErasureRequest = (erasureId: string, runAfter?: Date): BackgroundJobRequest => {
  if (!runAfter) return backgroundJobRequest(VOICE_RECORDING_ERASURE_JOB, { erasureId }, { idempotencyKey: erasureId });
  const minute = new Date(Math.ceil(runAfter.getTime() / 60_000) * 60_000);
  return backgroundJobRequest(VOICE_RECORDING_ERASURE_JOB, { erasureId }, { idempotencyKey: `${erasureId}@${minute.toISOString()}`, runAfter: minute });
};

const LEFT_REASON_OF_REQUEST_FAILURE: Partial<Record<VoiceRecordingRequestError["reason"], VoiceRecordingLeftReason>> = {
  rejected: "vendor_rejected",
  unreachable: "vendor_unreachable",
  timeout: "vendor_timeout",
  malformed_response: "vendor_malformed_response",
  oversized_response: "vendor_malformed_response",
};

const leftReasonOf = (error: unknown): VoiceRecordingLeftReason =>
  (error instanceof VoiceRecordingRequestError ? LEFT_REASON_OF_REQUEST_FAILURE[error.reason] : undefined) ?? "vendor_failed";

/** The wait before the next ask: the schedule's, or the vendor's `Retry-After` when that is longer. */
const delayBeforeNextAsk = (attempts: number, retryAfterSeconds?: number): number => {
  const scheduled = ASK_DELAYS_SECONDS[Math.min(Math.max(attempts, 1), ASK_DELAYS_SECONDS.length) - 1];
  return Math.max(scheduled, Math.min(retryAfterSeconds ?? 0, MAX_RETRY_AFTER_SECONDS));
};

/**
 * How `voice_recording_delete_total` counts: each ask's result, and `left_at_vendor` once for a
 * recording given up on. A closed set, beside the vendor.
 */
type VoiceRecordingDeleteOutcome = "deleted" | "already_absent" | "vendor_failed" | "rate_limited" | "credential_unreadable" | "left_at_vendor";

/**
 * What asking about one recording came to. `final`: no later ask can change it. `rate_limited`: the
 * vendor turned the request away without considering it and asked to be left alone for
 * `pauseSeconds`, so the run asks it nothing more and the ask does not count.
 */
type Ask =
  | { kind: "gone"; outcome: "deleted" | "already_absent" }
  | { kind: "held"; reason: VoiceRecordingLeftReason; final: boolean; delaySeconds: number; fields: Record<string, unknown> }
  | { kind: "rate_limited"; pauseSeconds: number }
  | { kind: "abandoned" };

/** The held key, opened for this run, or why none can be used. */
type OpenedCredential = { kind: "open"; credential: VoiceVendorCredential } | { kind: "absent" } | { kind: "unreadable"; errorClass: string };

/** What a run did, by counts and closed codes only. */
interface RunTally {
  deleted: number;
  alreadyAbsent: number;
  retrying: number;
  postponed: number;
  /** Recordings given up on, by why. */
  left: Partial<Record<VoiceRecordingLeftReason, number>>;
  /** Why the first recording still held was held: its code, and the vendor's reason and status only. */
  firstHeld: Record<string, unknown> | null;
}

const leftCount = (tally: Pick<RunTally, "left">): number => Object.values(tally.left).reduce((sum, count) => sum + (count ?? 0), 0);

interface VoiceRecordingErasureDrainDependencies {
  backlog: VoiceRecordingErasureBacklog;
  /** The backlog over a dead letter's transaction, so giving up commits with the park. */
  backlogIn: (db: Db) => Pick<VoiceRecordingErasureBacklog, "failExhausted">;
  sealer: Pick<VoiceVendorCredentialSealer, "open">;
  sources: Readonly<Record<VoiceVendor, Pick<VoiceRecordingSource, "deleteRecording">>>;
  audit: Pick<VoiceRecordingAudit, "deleted" | "left">;
  queue: Pick<BackgroundJobQueue, "enqueue">;
  /** Staff hear of every recording left at the vendor, by ids, counts and codes. */
  errorReporter?: Pick<ErrorReporter, "report"> | null;
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
 * One run of an erasure: gives up on what no ask can finish (claimed in one write, recorded in one
 * write, reported once), then claims its recordings that are due, leasing each, asks the vendor to
 * delete each with the held key, four at a time, and settles each. A recording the vendor deleted,
 * or no longer held, leaves the backlog with its `conversation.recording_deleted` record. One it
 * refused is kept, its next ask after the schedule's wait or the vendor's `Retry-After`, whichever
 * is longer, until its eighth ask; then it stays as left at the vendor, with its record, a warn log
 * naming where it is, and an error report to staff. A vendor that answers 429 is asked nothing more
 * this run, and every recording the run turned away or never reached waits for its `Retry-After`
 * (a minute when it names none, an hour at most), uncounted. The key is dropped as soon as no
 * pending recording needs it. Logs, reports and records carry ids, counts and closed codes only,
 * never the key or the vendor's answer.
 */
export class VoiceRecordingErasureDrain {
  constructor(private readonly deps: VoiceRecordingErasureDrainDependencies) {}

  async run(erasureId: string, signal: AbortSignal): Promise<void> {
    const claim = await this.deps.backlog.claim(erasureId, {
      limit: RECORDINGS_PER_RUN,
      leaseSeconds: CLAIM_LEASE_SECONDS,
      expireAfterSeconds: EXPIRE_AFTER_SECONDS,
    });
    // Gone: an earlier run drained it, and this one is a duplicate or a stale follow-up.
    if (claim.kind === "gone") return;

    const { erasure, items, givenUp } = claim;
    const tally: RunTally = { deleted: 0, alreadyAbsent: 0, retrying: 0, postponed: 0, left: {}, firstHeld: null };
    await this.leftAtVendorAll(erasure, givenUp, tally);

    let pausedForSeconds: number | null = null;
    const postponed: string[] = [];
    const { vendor } = erasure;
    if (items.length > 0 && isVoiceVendor(vendor)) {
      const credential = this.openCredential(erasure.sealedCredential);
      await forEachConcurrently(items, DELETE_CONCURRENCY, signal, async (item) => {
        if (pausedForSeconds !== null) {
          postponed.push(item.id);
          return;
        }
        const ask = await this.ask(vendor, credential, item, signal);
        if (ask.kind === "rate_limited") {
          pausedForSeconds = Math.max(pausedForSeconds ?? 0, ask.pauseSeconds);
          this.count(vendor, "rate_limited");
          postponed.push(item.id);
          return;
        }
        await this.settle({ ...erasure, vendor }, item, ask, tally);
      });
    }
    // Staff hear of what this run gave up on even when its deadline passed partway.
    if (leftCount(tally) > 0) this.reportLeft(erasureId, erasure, tally.left);
    // The deadline passed and the runtime has moved on: the claimed recordings come due when their lease ends.
    if (signal.aborted) return;
    if (postponed.length > 0) {
      await this.deps.backlog.postpone(postponed, pausedForSeconds ?? RATE_LIMIT_PAUSE_SECONDS.default);
      tally.postponed = postponed.length;
    }

    const remaining = await this.deps.backlog.release(erasureId);
    this.logRun(erasureId, erasure, tally, remaining.pending);
    if (remaining.pending === 0) return;
    await this.deps.queue.enqueue(voiceRecordingErasureRequest(erasureId, remaining.dueNow ? undefined : (remaining.nextAskAt ?? undefined)));
  }

  /**
   * The job itself kept failing: the recordings whose asks are spent are left at the vendor, with
   * their record; the rest stay pending for a later run, which the recovery sweep queues.
   */
  async giveUp(erasureId: string, transaction: Db): Promise<void> {
    const given = await this.deps.backlogIn(transaction).failExhausted(erasureId, MAX_ASKS_PER_RECORDING);
    if (!given || given.entries.length === 0) return;
    const tally: Pick<RunTally, "left"> = { left: {} };
    await this.leftAtVendorAll(given.erasure, given.entries, tally);
    this.deps.logger.warn(
      { erasureId, workspaceId: given.erasure.workspaceId, vendor: given.erasure.vendor, leftAtVendor: leftCount(tally), left: tally.left },
      "Voice recording erasure left recordings at the vendor",
    );
    this.reportLeft(erasureId, given.erasure, tally.left);
  }

  private openCredential(sealed: string | null): OpenedCredential {
    if (sealed === null) return { kind: "absent" };
    try {
      return { kind: "open", credential: this.deps.sealer.open(sealed) };
    } catch (error) {
      return { kind: "unreadable", errorClass: errorClassOf(error) };
    }
  }

  private async ask(vendor: VoiceVendor, credential: OpenedCredential, item: VoiceRecordingErasureItem, signal: AbortSignal): Promise<Ask> {
    const final = item.attempts >= MAX_ASKS_PER_RECORDING;
    const delaySeconds = delayBeforeNextAsk(item.attempts);
    if (credential.kind === "absent") {
      // The deletion found no key to hand over: no ask can be made, now or later.
      return { kind: "held", reason: item.failureReason ?? "credential_missing", final: true, delaySeconds, fields: {} };
    }
    if (credential.kind === "unreadable") {
      return { kind: "held", reason: "credential_unreadable", final, delaySeconds, fields: { errorClass: credential.errorClass } };
    }
    try {
      const outcome = await this.deps.sources[vendor].deleteRecording({
        vendorConversationId: item.vendorConversationId,
        region: item.region,
        credential: credential.credential,
        signal,
      });
      return { kind: "gone", outcome };
    } catch (error) {
      if (signal.aborted) return { kind: "abandoned" };
      const requestError = error instanceof VoiceRecordingRequestError ? error : null;
      if (requestError?.vendorStatus === RATE_LIMITED_STATUS) {
        const asked = requestError.retryAfterSeconds ?? RATE_LIMIT_PAUSE_SECONDS.default;
        return { kind: "rate_limited", pauseSeconds: Math.min(Math.max(asked, 1), RATE_LIMIT_PAUSE_SECONDS.max) };
      }
      return {
        kind: "held",
        reason: leftReasonOf(error),
        final,
        delaySeconds: delayBeforeNextAsk(item.attempts, requestError?.retryAfterSeconds),
        fields: recordingErrorFields(error),
      };
    }
  }

  private async settle(
    erasure: VoiceRecordingErasureSubject & { vendor: VoiceVendor },
    item: VoiceRecordingErasureItem,
    ask: Exclude<Ask, { kind: "rate_limited" }>,
    tally: RunTally,
  ): Promise<void> {
    if (ask.kind === "abandoned") return;
    if (ask.kind === "gone") {
      this.count(erasure.vendor, ask.outcome);
      if (ask.outcome === "deleted") tally.deleted += 1;
      else tally.alreadyAbsent += 1;
      await this.recordDeleted(erasure, item, ask.outcome);
      await this.deps.backlog.remove(item.id);
      return;
    }
    if (ask.reason !== "credential_missing") this.count(erasure.vendor, ask.reason === "credential_unreadable" ? "credential_unreadable" : "vendor_failed");
    tally.firstHeld ??= { outcome: ask.reason, ...ask.fields };
    if (!ask.final) {
      tally.retrying += 1;
      await this.deps.backlog.keep(item.id, ask.reason, ask.delaySeconds);
      return;
    }
    // Only the run that changed the row gives up on it, so its record is written once.
    if (await this.deps.backlog.fail(item.id, ask.reason)) await this.leftAtVendor(erasure, item, ask.reason, ask.fields, tally);
  }

  /** The recording is gone at the vendor, so a failed audit write is logged with its ids rather than asked again. */
  private async recordDeleted(erasure: VoiceRecordingErasureSubject & { vendor: VoiceVendor }, item: VoiceRecordingErasureItem, outcome: "deleted" | "already_absent"): Promise<void> {
    await this.deps.audit
      .deleted({ accountId: erasure.accountId, workspaceId: erasure.workspaceId, conversationId: item.conversationId, vendor: erasure.vendor, outcome })
      .catch((error: unknown) => {
        this.deps.logger.warn(
          { workspaceId: erasure.workspaceId, conversationId: item.conversationId, vendor: erasure.vendor, errorClass: errorClassOf(error) },
          "Voice recording deletion could not be audited",
        );
      });
  }

  /** One recording an ask gave up on: counted, logged with where it is so an operator can delete it there, and recorded for its organization. */
  private async leftAtVendor(
    erasure: Pick<VoiceRecordingErasureSubject, "accountId" | "workspaceId" | "vendor">,
    entry: VoiceRecordingErasureEntry,
    reason: VoiceRecordingLeftReason,
    fields: Record<string, unknown>,
    tally: Pick<RunTally, "left">,
  ): Promise<void> {
    const { vendor, workspaceId } = erasure;
    const { conversationId, vendorConversationId } = entry;
    tally.left[reason] = (tally.left[reason] ?? 0) + 1;
    this.count(vendor, "left_at_vendor");
    this.deps.logger.warn(
      { workspaceId, conversationId, vendorConversationId, vendor, outcome: reason, attempts: entry.attempts, ...fields },
      "Voice recording was left at the vendor",
    );
    await this.recordLeft(erasure, [{ conversationId, vendorConversationId, reason }]);
  }

  /**
   * Recordings given up on together, however many: counted once, recorded in one write, and left to
   * the run's own log line and report rather than a line each.
   */
  private async leftAtVendorAll(
    erasure: Pick<VoiceRecordingErasureSubject, "accountId" | "workspaceId" | "vendor">,
    entries: readonly VoiceRecordingGivenUp[],
    tally: Pick<RunTally, "left">,
  ): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) tally.left[entry.failureReason] = (tally.left[entry.failureReason] ?? 0) + 1;
    this.count(erasure.vendor, "left_at_vendor", entries.length);
    await this.recordLeft(erasure, entries.map(({ conversationId, vendorConversationId, failureReason }) => ({ conversationId, vendorConversationId, reason: failureReason })));
  }

  private async recordLeft(
    erasure: Pick<VoiceRecordingErasureSubject, "accountId" | "workspaceId" | "vendor">,
    recordings: Array<{ conversationId: string | null; vendorConversationId: string; reason: VoiceRecordingLeftReason }>,
  ): Promise<void> {
    const { accountId, workspaceId, vendor } = erasure;
    await this.deps.audit.left({ accountId, workspaceId, vendor, recordings }).catch((error: unknown) => {
      this.deps.logger.warn({ workspaceId, vendor, recordings: recordings.length, errorClass: errorClassOf(error) }, "Voice recordings left at the vendor could not be audited");
    });
  }

  /** Staff hear of every batch of recordings left at the vendor: ids, counts and codes, never a recording's content or key. */
  private reportLeft(
    erasureId: string,
    erasure: { accountId: string; workspaceId: string; vendor: string },
    left: Partial<Record<VoiceRecordingLeftReason, number>>,
  ): void {
    void this.deps.errorReporter?.report({
      errorType: "voice.recording_left_at_vendor",
      severity: "warn",
      correlation: { workspaceId: erasure.workspaceId },
      metadata: { erasureId, accountId: erasure.accountId, vendor: erasure.vendor, leftAtVendor: leftCount({ left }), reasons: left },
    }).catch(() => undefined);
  }

  private logRun(erasureId: string, erasure: VoiceRecordingErasureSubject, tally: RunTally, pending: number): void {
    const { firstHeld, left, ...counts } = tally;
    const fields = {
      erasureId,
      workspaceId: erasure.workspaceId,
      vendor: erasure.vendor,
      ...counts,
      leftAtVendor: leftCount(tally),
      pending,
      ...(firstHeld ? { firstHeld } : {}),
      ...(leftCount(tally) > 0 ? { left } : {}),
    };
    if (tally.retrying > 0 || tally.postponed > 0 || leftCount(tally) > 0) this.deps.logger.warn(fields, "Voice recording erasure left recordings at the vendor");
    else this.deps.logger.info(fields, "Voice recording erasure ran");
  }

  private count(vendor: string, outcome: VoiceRecordingDeleteOutcome, value = 1): void {
    this.deps.metrics?.incrementCounter("voice_recording_delete_total", {
      help: "Voice recording deletions at the vendor, by vendor and outcome: each ask's result, and left_at_vendor once a recording is given up on",
      labels: { vendor, outcome },
      value,
    });
  }
}

/** The erasure job's handler: one run per claim, and giving up, with the park, once the job is dead-lettered. */
export const voiceRecordingErasureJobHandler = (drain: VoiceRecordingErasureDrain): BackgroundJobHandlerRegistration =>
  backgroundJobHandler(VOICE_RECORDING_ERASURE_JOB, ({ erasureId }, { signal }) => drain.run(erasureId, signal), {
    onDeadLetter: async (payload, { idempotencyKey, transaction }) => {
      const erasureId = payload?.erasureId ?? idempotencyKey?.split("@")[0];
      if (erasureId) await drain.giveUp(erasureId, transaction);
    },
  });

/** Pending recordings overdue by this much have no job working on them: past a claim's lease and the runtime's retry waits. */
const OVERDUE_SECONDS = 15 * 60;
/** Erasures one recovery run queues again. */
const RECOVERY_BATCH = 100;

/**
 * Queues a run again for every erasure whose pending recordings are overdue: work a lost wake, a
 * dead letter whose hand-back failed, or a crash left with no job. A run already queued for it
 * absorbs the request. Returns how many it queued.
 */
export const recoverStrandedVoiceRecordingErasures = async (deps: {
  backlog: Pick<VoiceRecordingErasureBacklog, "overdueErasures">;
  queue: Pick<BackgroundJobQueue, "enqueue">;
  logger: Pick<AppLogger, "warn">;
}): Promise<number> => {
  const erasureIds = await deps.backlog.overdueErasures(OVERDUE_SECONDS, RECOVERY_BATCH);
  for (const erasureId of erasureIds) await deps.queue.enqueue(voiceRecordingErasureRequest(erasureId));
  if (erasureIds.length > 0) deps.logger.warn({ erasures: erasureIds.length }, "Voice recording erasures with overdue recordings were queued again");
  return erasureIds.length;
};
