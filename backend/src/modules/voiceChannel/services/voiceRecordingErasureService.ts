import type { VendorHeldConversationDataErasure } from "../../../shared/domain/conversationDataErasure.js";
import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import type {
  VoiceRecordingErasureBacklog,
  VoiceRecordingErasureHandOff,
  VoiceRecordingErasurePort,
  VoiceRecordingStore,
  VoiceRecordingToErase,
  VoiceVendorCredentialReader,
  VoiceVendorCredentialSealer,
} from "../domain.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

/** Where the erasure job's runs are queued: inside the deletion's transaction, and woken once it committed. */
interface VoiceRecordingErasureJobs {
  /** Queues the run of one erasure with the deletion's own writes. */
  queue(erasureId: string): Promise<void>;
  /** Asks a worker to look now. Never rejects. */
  wake(): Promise<void>;
}

/** The recordings, the backlog and the job queue, bound to one deletion's transaction; the key reads and the sealer. */
interface VoiceRecordingErasureHandOffDependencies {
  recordings: Pick<VoiceRecordingStore, "listRecordings">;
  backlog: Pick<VoiceRecordingErasureBacklog, "hold">;
  credentials: Pick<VoiceVendorCredentialReader, "read">;
  sealer: Pick<VoiceVendorCredentialSealer, "seal">;
  jobs: VoiceRecordingErasureJobs;
  logger: Pick<AppLogger, "warn">;
}

const NOTHING_HANDED_OFF = { afterCommit: async () => undefined };

/**
 * Hands the recordings in a deletion's scope to the erasure backlog, inside the deletion's
 * transaction: for each workspace and vendor in scope, the recordings (read and locked
 * while the voice sessions that name them still exist) and the workspace's key for that vendor,
 * sealed, because a workspace's deletion takes its credential store with it. Each hand-off queues
 * its run of the erasure job in the same transaction, so the deletion and the backlog commit
 * together or not at all; `afterCommit` wakes a worker to start at once.
 *
 * A read that fails rejects, and the deletion fails whole, to be run again. A workspace with no key,
 * or one the backend cannot decrypt, still hands its recordings off: the job records each as left
 * at the vendor, with why.
 */
export class VoiceRecordingErasureService implements VoiceRecordingErasurePort {
  constructor(private readonly dependencies: VoiceRecordingErasureHandOffDependencies) {}

  async handOff(erasure: VendorHeldConversationDataErasure): Promise<{ afterCommit(): Promise<void> }> {
    // A call can be in two scopes at once (a visitor's conversation, started by their key): once is enough.
    const seen = new Set<string>();
    let handedOff = 0;
    for (const scope of erasure.scopes) {
      const recordings = (await this.listRecordings(scope)).filter((recording) => {
        const key = `${recording.vendor}:${recording.region}:${recording.vendorConversationId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      for (const vendor of new Set(recordings.map((recording) => recording.vendor))) {
        const ofVendor = recordings.filter((recording) => recording.vendor === vendor);
        const erasureId = await this.dependencies.backlog.hold({
          accountId: erasure.accountId,
          workspaceId: scope.workspaceId,
          vendor,
          credential: await this.sealedCredential(scope.workspaceId, vendor),
          recordings: ofVendor.map(({ conversationId, region, vendorConversationId }) => ({ conversationId, region, vendorConversationId })),
        });
        await this.dependencies.jobs.queue(erasureId);
        handedOff += ofVendor.length;
      }
    }
    return handedOff > 0 ? { afterCommit: () => this.dependencies.jobs.wake() } : NOTHING_HANDED_OFF;
  }

  private async listRecordings(scope: VendorHeldConversationDataErasure["scopes"][number]): Promise<VoiceRecordingToErase[]> {
    try {
      return await this.dependencies.recordings.listRecordings(scope);
    } catch (error) {
      this.dependencies.logger.warn(
        { workspaceId: scope.workspaceId, scope: scope.kind, errorClass: errorClassOf(error) },
        "Voice recordings to delete could not be read",
      );
      throw error;
    }
  }

  /**
   * The workspace's key for the vendor, read while the workspace still holds it and sealed for the
   * backlog. A credential store that cannot be read at all rejects, like the recordings' read.
   */
  private async sealedCredential(workspaceId: string, vendor: VoiceVendor): Promise<VoiceRecordingErasureHandOff["credential"]> {
    let reading;
    try {
      reading = await this.dependencies.credentials.read({ workspaceId, vendor });
    } catch (error) {
      this.dependencies.logger.warn({ workspaceId, vendor, errorClass: errorClassOf(error) }, "Voice vendor key to delete recordings with could not be read");
      throw error;
    }
    if (reading.kind === "present") return { kind: "sealed", sealed: this.dependencies.sealer.seal(reading.credential) };
    return { kind: "absent", reason: reading.kind === "missing" ? "credential_missing" : "credential_unreadable" };
  }
}
