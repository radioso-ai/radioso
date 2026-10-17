import type { VoiceVendor } from "../../../shared/domain/voiceVendor.js";
import type {
  VoiceRecordingErasurePort,
  VoiceRecordingRef,
  VoiceRecordingScope,
  VoiceVendorCredential,
} from "../domain.js";
import { errorClassOf, recordingErrorFields, type VoiceRecordingDependencies } from "./voiceRecordingService.js";

/** At most this many vendor deletes run at once, so a large workspace does not flood the vendor. */
const DELETE_CONCURRENCY = 4;
/**
 * How long an erasure keeps asking the vendor. It runs inside the deletion's request, which must
 * finish; what is left past it stays at the vendor and is logged with its count.
 */
const ERASURE_DEADLINE_MS = 20_000;

type VoiceRecordingDeleteOutcome =
  | "deleted"
  | "vendor_failed"
  | "credential_missing"
  | "credential_unreadable"
  | "credential_read_failed"
  | "deadline_passed";

/** The workspace's key for one vendor, read at `prepare`, or why the vendor's recordings stay. */
type VendorCredential = { kind: "present"; credential: VoiceVendorCredential } | { kind: "absent"; outcome: VoiceRecordingDeleteOutcome };

type CredentialOfVendor = Map<VoiceVendor, VendorCredential>;

/**
 * Deletes recordings at the vendor when Radioso deletes their conversations. `prepare` reads the
 * recordings and the workspace's vendor key while both still exist (a workspace's deletion takes
 * its key with it); `erase` asks the vendor to delete each one, after the conversations are gone,
 * and never rejects, so a vendor that refuses or cannot be reached never holds a deletion back. A
 * recording left at the vendor is logged and counted, with ids only.
 */
export class VoiceRecordingErasureService implements VoiceRecordingErasurePort {
  constructor(
    private readonly dependencies: VoiceRecordingDependencies,
    /** Tests only. */
    private readonly limits: { deadlineMs?: number; concurrency?: number; now?: () => number } = {},
  ) {}

  async prepare(scope: VoiceRecordingScope): Promise<{ recordingCount: number; erase(): Promise<void> }> {
    let recordings: VoiceRecordingRef[];
    try {
      recordings = await this.dependencies.recordings.listRecordings(scope);
    } catch (error) {
      this.dependencies.logger.warn({ workspaceId: scope.workspaceId, errorClass: errorClassOf(error) }, "Voice recordings to delete could not be read");
      return { recordingCount: 0, erase: async () => undefined };
    }
    if (recordings.length === 0) return { recordingCount: 0, erase: async () => undefined };
    const credentials = await this.readCredentials(scope.workspaceId, recordings);
    return {
      recordingCount: recordings.length,
      erase: () => this.erase(scope, recordings, credentials),
    };
  }

  private async readCredentials(workspaceId: string, recordings: readonly VoiceRecordingRef[]): Promise<CredentialOfVendor> {
    const credentials: CredentialOfVendor = new Map();
    for (const vendor of new Set(recordings.map((recording) => recording.vendor))) {
      try {
        const reading = await this.dependencies.credentials.read({ workspaceId, vendor });
        credentials.set(vendor, reading.kind === "present"
          ? reading
          : { kind: "absent", outcome: reading.kind === "missing" ? "credential_missing" : "credential_unreadable" });
      } catch {
        credentials.set(vendor, { kind: "absent", outcome: "credential_read_failed" });
      }
    }
    return credentials;
  }

  private async erase(scope: VoiceRecordingScope, recordings: readonly VoiceRecordingRef[], credentials: CredentialOfVendor): Promise<void> {
    const now = this.limits.now ?? Date.now;
    const deadline = now() + (this.limits.deadlineMs ?? ERASURE_DEADLINE_MS);
    const queue = [...recordings];
    const worker = async (): Promise<void> => {
      while (now() < deadline) {
        const recording = queue.shift();
        if (!recording) return;
        await this.eraseOne(scope, recording, credentials.get(recording.vendor));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.limits.concurrency ?? DELETE_CONCURRENCY, queue.length) }, worker));
    if (queue.length === 0) return;
    this.dependencies.logger.warn(
      { workspaceId: scope.workspaceId, outcome: "deadline_passed", recordingCount: queue.length },
      "Voice recordings were left at the vendor",
    );
    for (const vendor of new Set(queue.map((recording) => recording.vendor))) {
      this.record(vendor, "deadline_passed", queue.filter((recording) => recording.vendor === vendor).length);
    }
  }

  private async eraseOne(
    scope: VoiceRecordingScope,
    recording: VoiceRecordingRef,
    credential: VendorCredential | undefined,

  ): Promise<void> {
    const { workspaceId } = scope;
    const { conversationId, vendor } = recording;
    const left = (outcome: VoiceRecordingDeleteOutcome, fields: Record<string, unknown> = {}): void => {
      this.dependencies.logger.warn({ workspaceId, conversationId, vendor, outcome, ...fields }, "Voice recording was left at the vendor");
      this.record(vendor, outcome);
    };
    if (!credential || credential.kind === "absent") {
      left(credential?.outcome ?? "credential_read_failed");
      return;
    }
    try {
      await this.dependencies.sources[vendor].deleteRecording({
        vendorConversationId: recording.vendorConversationId,
        region: recording.region,
        credential: credential.credential,
      });
    } catch (error) {
      left("vendor_failed", recordingErrorFields(error));
      return;
    }
    this.record(vendor, "deleted");
    await this.dependencies.audit
      .deleted({ workspaceId, workspaceDeleted: scope.kind === "workspace", conversationId, vendor })
      .catch((error: unknown) => {
        this.dependencies.logger.warn({ workspaceId, conversationId, vendor, errorClass: errorClassOf(error) }, "Voice recording deletion could not be audited");
      });
  }

  private record(vendor: VoiceVendor, outcome: VoiceRecordingDeleteOutcome, value = 1): void {
    this.dependencies.metrics?.incrementCounter("voice_recording_delete_total", {
      help: "Voice recordings Radioso asked the vendor to delete, by vendor and how the request ended",
      labels: { vendor, outcome },
      ...(value === 1 ? {} : { value }),
    });
  }

}
